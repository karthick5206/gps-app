package com.sasvata.veetrax.trackerengine

import android.content.Context
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sends queued points to `POST ${serverUrl}/api/tracker/v1/positions` (API.md §3). Blocking; called only on the
 * engine's background thread. Each HTTP call holds a partial WakeLock with a 30 s timeout so the CPU doesn't
 * sleep mid-request; it is always released in `finally`.
 */
class Uploader(context: Context, private val prefs: Prefs, private val queue: PointQueue) {

  sealed class Outcome {
    /** Accepted (or queue empty / nothing to do). */
    object Done : Outcome()
    /** Network or any other server answer: nothing is dropped, try again at prefs.backoffUntil. */
    object Retry : Outcome()
    /** 401 REVOKED / INVALID (clearToken = true) or 403 INACTIVE: stop tracking. */
    data class Stop(val reason: String, val clearToken: Boolean) : Outcome()
  }

  private class Http(val code: Int, val body: String)

  /** Phone health (Health.snapshot) sent with every batch; set by the Engine. */
  var health: (() -> JSONObject)? = null

  companion object {
    private const val TIMEOUT_MS = 12_000
    private const val WAKELOCK_MS = 30_000L
    private const val BACKOFF_BASE_MS = 5_000L
    private const val BACKOFF_MAX_MS = 10 * 60_000L
    private const val FAILURES_WORTH_REPORTING = 3
    private const val MAX_BATCHES_PER_RUN = 400 // 400 × 500 > queue cap: one run can always drain it
  }

  private val wakeLock: PowerManager.WakeLock =
    (context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VeeTrax:upload")
      .apply { setReferenceCounted(false) }

  /** Called with the config the server returns on success. */
  var onConfig: ((JSONObject) -> Unit)? = null

  /** Called with the server's answer to "must this phone track?" (app 1.3.4+ servers send it). */
  var onRequired: ((Boolean) -> Unit)? = null

  /** The number moved to another phone; the server still takes the points recorded before that. */
  var onRevoked: (() -> Unit)? = null

  /** While tracking is off there are no uploads to carry the answer, so the watchdog asks. Null when it can't tell. */
  fun fetchRequired(token: String): Boolean? {
    wakeLock.acquire(WAKELOCK_MS)
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL("${prefs.serverUrl}/api/tracker/v1/me").openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        useCaches = false
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Authorization", "Bearer $token")
      }
      if (conn.responseCode !in 200..299) return null
      val json = JSONObject(conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
      if (json.has("required")) json.optBoolean("required") else null
    } catch (_: Exception) {
      null
    } finally {
      conn?.disconnect()
      if (wakeLock.isHeld) wakeLock.release()
    }
  }

  /** Uploads the queue oldest first in batches of config.batchMax until it is empty or a call fails. */
  fun drain(): Outcome {
    val token = prefs.token ?: return Outcome.Done
    repeat(MAX_BATCHES_PER_RUN) {
      val batch = queue.peek(prefs.config.batchMax)
      if (batch.isEmpty()) {
        if (prefs.revokedDraining) return Outcome.Stop("REVOKED", clearToken = true)
        // No points, but the server should still hear about a stop or restart (the health report carries them).
        return if (prefs.hasPendingEvents()) send(token, batch) else Outcome.Done
      }
      when (val o = send(token, batch)) {
        Outcome.Done -> queue.remove(batch.map { it.t })
        else -> return o
      }
    }
    return Outcome.Done
  }

  /**
   * Sends one batch and updates status / backoff. Done = the server has it, the caller removes it from the queue.
   */
  fun send(token: String, batch: List<Point>): Outcome {
    val payload = JSONObject().put("positions", JSONArray().apply { batch.forEach { put(it.toJson()) } })
    val healthReport = runCatching { health?.invoke() }.getOrNull()
    healthReport?.let { payload.put("health", it) }
    val body = payload.toString()
    val res = try {
      post("${prefs.serverUrl}/api/tracker/v1/positions", token, body)
    } catch (e: IOException) {
      return backoff("Network error: ${e.message ?: e.javaClass.simpleName}")
    } catch (e: Exception) {
      return backoff("Upload failed: ${e.message ?: e.javaClass.simpleName}")
    }
    val json = runCatching { JSONObject(res.body) }.getOrNull()
    val code = json?.optString("code")?.takeIf { it.isNotEmpty() }
    val message = json?.let { messageOf(it) } ?: "HTTP ${res.code}"
    return when {
      res.code in 200..299 -> {
        prefs.ackEvents(healthReport?.optJSONArray("events")?.length() ?: 0)
        // Late uploads otherwise leave no trace: the error is cleared here, and failures never reach the server themselves.
        if (prefs.failures >= FAILURES_WORTH_REPORTING) prefs.recordEvent("upload", "worked after ${prefs.failures} failures: ${prefs.lastError ?: "unknown error"}")
        prefs.lastUploadAt = System.currentTimeMillis()
        prefs.lastError = null
        prefs.failures = 0
        prefs.backoffUntil = 0
        json?.optJSONObject("config")?.let { cfg -> onConfig?.invoke(cfg) }
        if (json?.has("required") == true) onRequired?.invoke(json.optBoolean("required"))
        if (json?.optBoolean("revoked") == true) onRevoked?.invoke()
        Outcome.Done
      }
      res.code == 401 -> Outcome.Stop(if (code == "REVOKED") "REVOKED" else "INVALID", clearToken = true)
      res.code == 403 && code == "INACTIVE" -> Outcome.Stop("INACTIVE", clearToken = false)
      res.code == 408 || res.code == 429 || res.code >= 500 -> backoff("Server: $message")
      // Any other answer is kept and retried too: a proxy or a server bug must never cost points.
      else -> backoff("Rejected: $message")
    }
  }

  private fun messageOf(o: JSONObject): String? {
    val m = o.opt("message")
    return when (m) {
      is String -> m
      is JSONArray -> (0 until m.length()).joinToString(", ") { m.optString(it) }
      else -> null
    }
  }

  private fun backoff(error: String): Outcome {
    val failures = prefs.failures + 1
    val delay = minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(failures - 1, 10))
    prefs.failures = failures
    prefs.backoffUntil = System.currentTimeMillis() + delay
    prefs.lastError = error
    return Outcome.Retry
  }

  private fun post(url: String, token: String, body: String): Http {
    wakeLock.acquire(WAKELOCK_MS)
    var conn: HttpURLConnection? = null
    try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        doOutput = true
        useCaches = false
        setRequestProperty("Content-Type", "application/json; charset=utf-8")
        setRequestProperty("Accept", "application/json")
        setRequestProperty("Authorization", "Bearer $token")
      }
      val bytes = body.toByteArray(Charsets.UTF_8)
      conn.setFixedLengthStreamingMode(bytes.size)
      conn.outputStream.use { it.write(bytes) }
      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
      return Http(code, text)
    } finally {
      conn?.disconnect()
      if (wakeLock.isHeld) wakeLock.release()
    }
  }
}
