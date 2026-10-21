package com.sasvata.veetrax.trackerengine

import android.location.Location
import kotlin.math.max

/**
 * Phone-side filter that runs BEFORE a fix is queued. Rules, in order:
 *
 *  1. Invalid coordinates, or a fix not newer than the last queued one → drop.
 *  2. Mock (fake-GPS) location → drop (counted in status as mockCount).
 *  3. Accuracy worse than 50 m → drop. Exception: if nothing was accepted for 2 minutes (or ever), allow up
 *     to 150 m so tracking never goes silent in poor-signal places.
 *  4. Jump: implied speed from the last accepted fix (the anchor) above 55 m/s (~200 km/h) → drop, unless
 *     3 consecutive such fixes agree with each other (then the anchor was the wrong one: accept and re-anchor).
 *  5. Stationary: reported speed < 1 m/s and within max(15 m, 2 × accuracy) of the anchor → send at most one
 *     point per stoppedIntervalSec as a heartbeat; the rest are skipped (not an error, not counted as dropped).
 *
 * The anchor is persisted, the jump "suspects" are not (a restart simply starts collecting them again).
 */
class JumpFilter(private val prefs: Prefs) {

  enum class Verdict { ACCEPT, INVALID, OLD, MOCK, INACCURATE, JUMP, STATIONARY_SKIP }

  companion object {
    const val GOOD_ACCURACY_M = 50f
    const val FALLBACK_ACCURACY_M = 150f
    const val SILENT_MS = 2 * 60_000L
    const val MAX_SPEED_MPS = 55.0
    const val JUMP_CONFIRMATIONS = 3
    const val STILL_SPEED_MPS = 1f

    fun distance(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Float {
      val out = FloatArray(1)
      Location.distanceBetween(lat1, lng1, lat2, lng2, out)
      return out[0]
    }

    fun distance(a: Anchor, p: Point) = distance(a.lat, a.lng, p.lat, p.lng)

    /** Implied speed between two fixes, m/s (time difference floored at 1 s). */
    fun impliedSpeed(t1: Long, lat1: Double, lng1: Double, t2: Long, lat2: Double, lng2: Double): Double {
      val dt = max(1.0, (t2 - t1) / 1000.0)
      return distance(lat1, lng1, lat2, lng2) / dt
    }

    /** "Standing still" relative to the anchor: slow reported speed and inside the GPS drift radius. */
    fun isStill(p: Point, a: Anchor): Boolean {
      val spd = p.spd ?: return false
      val radius = max(15f, 2f * (p.acc ?: 0f))
      return spd < STILL_SPEED_MPS && distance(a, p) <= radius
    }
  }

  private val suspects = ArrayList<Point>()

  fun check(p: Point, stoppedIntervalMs: Long): Verdict {
    if (!p.lat.isFinite() || !p.lng.isFinite() || kotlin.math.abs(p.lat) > 90 || kotlin.math.abs(p.lng) > 180 ||
      (p.lat == 0.0 && p.lng == 0.0)
    ) return Verdict.INVALID
    if (p.t <= prefs.lastQueuedT) return Verdict.OLD
    if (p.mock) return Verdict.MOCK

    val anchor = prefs.anchor
    val silent = anchor == null || p.t - anchor.t > SILENT_MS
    val limit = if (silent) FALLBACK_ACCURACY_M else GOOD_ACCURACY_M
    if ((p.acc ?: 0f) > limit) return Verdict.INACCURATE

    if (anchor == null) return Verdict.ACCEPT

    if (impliedSpeed(anchor.t, anchor.lat, anchor.lng, p.t, p.lat, p.lng) > MAX_SPEED_MPS) {
      // Either this fix jumped, or the anchor itself was a bad fix. Collect fixes that agree with each other.
      val prev = suspects.lastOrNull()
      if (prev != null && impliedSpeed(prev.t, prev.lat, prev.lng, p.t, p.lat, p.lng) <= MAX_SPEED_MPS) {
        suspects.add(p)
      } else {
        suspects.clear()
        suspects.add(p)
      }
      if (suspects.size >= JUMP_CONFIRMATIONS) {
        suspects.clear()
        return Verdict.ACCEPT
      }
      return Verdict.JUMP
    }
    suspects.clear()

    if (isStill(p, anchor) && p.t - anchor.t < stoppedIntervalMs) return Verdict.STATIONARY_SKIP
    return Verdict.ACCEPT
  }

  fun reset() {
    suspects.clear()
  }
}
