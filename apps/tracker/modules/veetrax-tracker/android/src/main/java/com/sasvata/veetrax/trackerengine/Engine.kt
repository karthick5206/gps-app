package com.sasvata.veetrax.trackerengine

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import org.json.JSONObject
import java.util.concurrent.Executor
import kotlin.math.max

/**
 * Process-wide tracking engine. Everything (filter, SQLite queue, HTTP upload, mode switching, SOS) runs on ONE
 * background HandlerThread, so there is no locking and nothing touches the UI thread. Lives independently of
 * the JS runtime: the service, the boot receiver and the watchdog all use it directly.
 *
 * Battery rules:
 *  - Uploads are event-driven: after an accepted fix, coalesced to ≥ 20 s apart while moving and ≥ 60 s while
 *    stationary, plus exponential backoff after failures; the network is used only when the queue is not empty.
 *  - The only repeating timer is the 60 s idle check while the service runs.
 *  - Adaptive GPS: see [Mode].
 */
class Engine private constructor(context: Context) {

  /**
   * MOVING: high-accuracy GPS at config.intervalSec. Switch to STATIONARY after 2 min standing still
   * (speed < 1 m/s within the drift radius), or when no fix arrived for 2 min (the distance filter suppresses
   * updates when we don't move). STATIONARY: balanced power at stoppedIntervalSec with batched delivery; back to
   * MOVING as soon as a fix is > max(30 m, 2 × accuracy) from the anchor or speed > 2 m/s.
   */
  enum class Mode { MOVING, STATIONARY }

  companion object {
    private const val TAG = "VeeTraxTracker"
    private const val STILL_TO_STATIONARY_MS = 2 * 60_000L
    private const val NO_FIX_TO_STATIONARY_MS = 2 * 60_000L
    private const val IDLE_CHECK_MS = 60_000L
    private const val UPLOAD_GAP_MOVING_MS = 20_000L
    private const val UPLOAD_GAP_STATIONARY_MS = 60_000L
    private const val MOVE_SPEED_MPS = 2f
    private const val MOVE_MIN_DISTANCE_M = 30f
    private const val SOS_TIMEOUT_MS = 15_000L

    @Volatile
    private var instance: Engine? = null

    fun get(context: Context): Engine =
      instance ?: synchronized(this) { instance ?: Engine(context.applicationContext).also { instance = it } }
  }

  val context: Context = context.applicationContext
  val prefs = Prefs(this.context)
  private val queue = PointQueue(this.context)
  private val filter = JumpFilter(prefs)
  private val uploader = Uploader(this.context, prefs, queue)

  private val thread = HandlerThread("veetrax-tracker").apply { start() }
  val looper: Looper get() = thread.looper
  private val handler = Handler(thread.looper)
  private val executor = Executor { handler.post(it) }

  /** Set by the service while it runs (written on the main thread, read on ours). */
  @Volatile
  var service: TrackerService? = null

  @Volatile
  var mode = Mode.MOVING
    private set

  private var stillSince: Long? = null
  private var lastRawFixElapsed = 0L
  private var lastUploadElapsed = 0L

  init {
    uploader.onConfig = { cfg -> applyConfig(TrackerConfig.merge(prefs.config, cfg)) }
  }

  private fun elapsed() = SystemClock.elapsedRealtime()

  /** Runs [block] on the engine thread; an exception is logged and kept as lastError, never kills the thread. */
  fun post(block: (Engine) -> Unit) {
    handler.post { guarded { block(this) } }
  }

  private inline fun guarded(block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      Log.e(TAG, "engine error", e)
      prefs.lastError = "Internal error: ${e.message ?: e.javaClass.simpleName}"
    }
  }

  // ---------------------------------------------------------------- service lifecycle (engine thread)

  fun onServiceStarted() {
    mode = Mode.MOVING
    stillSince = null
    lastRawFixElapsed = elapsed()
    filter.reset()
    service?.requestUpdates(mode, prefs.config)
    handler.removeCallbacks(idleCheck)
    handler.postDelayed(idleCheck, IDLE_CHECK_MS)
    requestUpload(force = true)
  }

  fun onServiceStopped() {
    handler.removeCallbacks(idleCheck)
    // Points recorded before Stop are still sent (normal coalescing / backoff).
    requestUpload(force = false)
  }

  /** Re-applies the location request (after a config change or a new start()). */
  fun reconfigure() {
    service?.requestUpdates(mode, prefs.config)
  }

  fun applyConfig(next: TrackerConfig) {
    val prev = prefs.config
    prefs.config = next
    if (prev.intervalSec != next.intervalSec || prev.distanceM != next.distanceM ||
      prev.stoppedIntervalSec != next.stoppedIntervalSec
    ) reconfigure()
  }

  private val idleCheck = object : Runnable {
    override fun run() {
      if (service == null) return
      guarded {
        if (mode == Mode.MOVING && elapsed() - lastRawFixElapsed > NO_FIX_TO_STATIONARY_MS) setMode(Mode.STATIONARY)
        requestUpload(force = false)
      }
      handler.postDelayed(this, IDLE_CHECK_MS)
    }
  }

  private fun setMode(next: Mode) {
    if (mode == next) return
    mode = next
    stillSince = null
    service?.requestUpdates(mode, prefs.config)
  }

  // ---------------------------------------------------------------- fixes (engine thread: FLP delivers on our Looper)

  fun onLocations(locations: List<Location>) = guarded {
    if (locations.isEmpty()) return@guarded
    val cfg = prefs.config
    val battery = Battery.read(context)
    val accepted = ArrayList<Point>()
    for (loc in locations.sortedBy { it.time }) {
      lastRawFixElapsed = elapsed()
      val p = Point.from(loc, battery)
      prefs.recordFix(p.t, p.acc, p.spd)
      updateMode(p, prefs.anchor)
      when (filter.check(p, cfg.stoppedIntervalSec * 1000L)) {
        JumpFilter.Verdict.ACCEPT -> {
          accepted.add(p)
          prefs.anchor = Anchor(p.t, p.lat, p.lng, p.acc ?: 0f)
          prefs.lastQueuedT = p.t
          prefs.lastAcceptedAt = p.t
        }
        JumpFilter.Verdict.MOCK -> prefs.bump("mockCount")
        JumpFilter.Verdict.INACCURATE, JumpFilter.Verdict.JUMP -> prefs.bump("droppedCount")
        else -> Unit
      }
    }
    if (accepted.isNotEmpty()) {
      queue.add(accepted)
      requestUpload(force = false)
    }
  }

  private fun updateMode(p: Point, anchor: Anchor?) {
    if (p.mock) return
    val acc = p.acc ?: 0f
    if (acc > JumpFilter.FALLBACK_ACCURACY_M) return // too vague to say anything about movement
    val fast = (p.spd ?: 0f) > MOVE_SPEED_MPS
    val far = anchor != null && JumpFilter.distance(anchor, p) > max(MOVE_MIN_DISTANCE_M, 2f * acc)
    when (mode) {
      Mode.STATIONARY -> if (fast || far) setMode(Mode.MOVING)
      Mode.MOVING -> {
        if (anchor != null && JumpFilter.isStill(p, anchor)) {
          val since = stillSince ?: p.t.also { stillSince = it }
          if (p.t - since >= STILL_TO_STATIONARY_MS) setMode(Mode.STATIONARY)
        } else {
          stillSince = null
        }
      }
    }
  }

  // ---------------------------------------------------------------- upload (engine thread)

  private val uploadRunnable = Runnable { guarded { runUpload() } }

  /**
   * Schedules an upload: at once when [force] (Start, "Upload now", SOS), otherwise no earlier than the
   * coalescing gap after the previous attempt and the backoff time. Does nothing when the queue is empty.
   */
  fun requestUpload(force: Boolean) {
    if (prefs.token.isNullOrEmpty() || queue.size() == 0L) return
    handler.removeCallbacks(uploadRunnable)
    if (force) {
      handler.post(uploadRunnable)
      return
    }
    val gap = if (mode == Mode.STATIONARY) UPLOAD_GAP_STATIONARY_MS else UPLOAD_GAP_MOVING_MS
    val byGap = if (lastUploadElapsed == 0L) 0L else lastUploadElapsed + gap - elapsed()
    val byBackoff = prefs.backoffUntil - System.currentTimeMillis()
    handler.postDelayed(uploadRunnable, max(0L, max(byGap, byBackoff)))
  }

  private fun runUpload() {
    lastUploadElapsed = elapsed()
    when (val o = uploader.drain()) {
      is Uploader.Outcome.Stop -> stopFromServer(o)
      Uploader.Outcome.Retry -> requestUpload(force = false)
      else -> Unit
    }
  }

  /** 401 REVOKED / INVALID: stop, clear token & queue. 403 INACTIVE: stop, keep the token. */
  private fun stopFromServer(o: Uploader.Outcome.Stop) {
    Log.i(TAG, "server stopped tracking: ${o.reason}")
    prefs.wanted = false
    prefs.stopReason = o.reason
    handler.removeCallbacks(uploadRunnable)
    if (o.clearToken) {
      prefs.token = null
      queue.clear()
      prefs.clearStatus()
      filter.reset()
    }
    WatchdogWorker.cancel(context)
    Starter.stop(context)
  }

  /** Sign-out: stop and forget everything (token, queue, status). */
  fun clearAll() {
    prefs.wanted = false
    handler.removeCallbacks(uploadRunnable)
    WatchdogWorker.cancel(context)
    Starter.stop(context)
    queue.clear()
    filter.reset()
    prefs.clearAll()
  }

  // ---------------------------------------------------------------- SOS

  /**
   * SOS: a fresh high-accuracy fix (up to 15 s), else the last known one; queued with sos=true and a time strictly
   * after the last queued point, then sent alone immediately, ignoring the backoff.
   * Result: "sent" | "queued" | "rejected" | "no_location" | "no_token" | "stopped".
   */
  @SuppressLint("MissingPermission")
  fun sendSos(done: (String) -> Unit) = post {
    val token = prefs.token
    if (token.isNullOrEmpty()) {
      done("no_token")
      return@post
    }
    if (!Starter.hasLocationPermission(context)) {
      done("no_location")
      return@post
    }
    val client = LocationServices.getFusedLocationProviderClient(context)
    val request = CurrentLocationRequest.Builder()
      .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
      .setDurationMillis(SOS_TIMEOUT_MS)
      .setMaxUpdateAgeMillis(10_000)
      .build()
    try {
      client.getCurrentLocation(request, CancellationTokenSource().token).addOnCompleteListener(executor) { task ->
        val fresh: Location? = if (task.isSuccessful) task.result else null
        if (fresh != null) {
          guardedSos(token, fresh, done)
        } else {
          try {
            client.lastLocation.addOnCompleteListener(executor) { last ->
              val loc: Location? = if (last.isSuccessful) last.result else null
              if (loc == null) done("no_location") else guardedSos(token, loc, done)
            }
          } catch (_: SecurityException) {
            done("no_location")
          }
        }
      }
    } catch (_: SecurityException) {
      done("no_location")
    }
  }

  private fun guardedSos(token: String, loc: Location, done: (String) -> Unit) {
    try {
      done(finishSos(token, loc))
    } catch (e: Exception) {
      Log.e(TAG, "sos failed", e)
      done("queued")
    }
  }

  private fun finishSos(token: String, loc: Location): String {
    val base = Point.from(loc, Battery.read(context), sos = true)
    val p = base.copy(t = max(base.t, prefs.lastQueuedT + 1))
    queue.add(listOf(p)) // safe even if the upload below fails or the process dies
    prefs.lastQueuedT = p.t
    return when (val o = uploader.send(token, listOf(p))) {
      is Uploader.Outcome.Done -> {
        queue.remove(listOf(p.t))
        requestUpload(force = false)
        "sent"
      }
      is Uploader.Outcome.Stop -> {
        stopFromServer(o)
        "stopped"
      }
      is Uploader.Outcome.Rejected -> {
        // The server refused the content (4xx); keeping it would block the queue.
        queue.remove(listOf(p.t))
        "rejected"
      }
      is Uploader.Outcome.Retry -> {
        requestUpload(force = false)
        "queued"
      }
    }
  }

  // ---------------------------------------------------------------- status for the app

  fun status(): Map<String, Any?> {
    fun time(v: Long): Double? = if (v > 0) v.toDouble() else null
    val cfg = prefs.config
    return mapOf(
      "running" to TrackerService.isRunning,
      "wanted" to prefs.wanted,
      "hasToken" to !prefs.token.isNullOrEmpty(),
      "serverUrl" to prefs.serverUrl,
      "mode" to mode.name.lowercase(),
      "lastFixAt" to time(prefs.lastFixAt),
      "lastAcc" to prefs.lastAcc?.toDouble(),
      "lastSpd" to prefs.lastSpd?.toDouble(),
      "lastAcceptedAt" to time(prefs.lastAcceptedAt),
      "lastUploadAt" to time(prefs.lastUploadAt),
      "lastError" to prefs.lastError,
      "failures" to prefs.failures.toDouble(),
      "backoffUntil" to time(prefs.backoffUntil),
      "queueSize" to queue.size().toDouble(),
      "mockCount" to prefs.mockCount.toDouble(),
      "droppedCount" to prefs.droppedCount.toDouble(),
      "stopReason" to prefs.stopReason,
      "config" to mapOf(
        "intervalSec" to cfg.intervalSec.toDouble(),
        "stoppedIntervalSec" to cfg.stoppedIntervalSec.toDouble(),
        "distanceM" to cfg.distanceM.toDouble(),
        "maxAccuracyM" to cfg.maxAccuracyM.toDouble(),
        "batchMax" to cfg.batchMax.toDouble(),
      ),
    )
  }
}
