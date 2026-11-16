import CoreLocation
import Foundation

/// Phone-side filter that labels doubtful fixes before they are queued. A straight port of Android's JumpFilter.kt
/// (same thresholds, same order of rules); the server does the real filtering.
final class JumpFilter {
  enum Verdict { case accept, invalid, old, mock, inaccurate, jump, stationarySkip }

  static let goodAccuracyM = 50.0
  static let fallbackAccuracyM = 150.0
  static let silentMs: Int64 = 2 * 60_000
  static let maxSpeedMps = 55.0
  static let jumpConfirmations = 3
  static let stillSpeedMps = 1.0
  static let clockToleranceMs: Int64 = 5 * 60_000
  static let speedConfirmFactor = 4.0

  static func distance(_ lat1: Double, _ lng1: Double, _ lat2: Double, _ lng2: Double) -> Double {
    CLLocation(latitude: lat1, longitude: lng1).distance(from: CLLocation(latitude: lat2, longitude: lng2))
  }

  static func distance(_ a: Anchor, _ p: Point) -> Double { distance(a.lat, a.lng, p.lat, p.lng) }

  /// Implied speed between two fixes, m/s (time difference floored at 1 s).
  static func impliedSpeed(_ t1: Int64, _ lat1: Double, _ lng1: Double, _ t2: Int64, _ lat2: Double, _ lng2: Double) -> Double {
    let dt = max(1.0, Double(t2 - t1) / 1000.0)
    return distance(lat1, lng1, lat2, lng2) / dt
  }

  /// The reported speed, unless the position doesn't back it up (same rule as the server's position-filter.ts).
  static func confirmedSpeed(_ p: Point, _ a: Anchor?) -> Double? {
    guard let spd = p.spd else { return nil }
    guard let a = a else { return spd }
    let implied = impliedSpeed(a.t, a.lat, a.lng, p.t, p.lat, p.lng)
    return implied < spd / speedConfirmFactor ? implied : spd
  }

  /// "Standing still" relative to the anchor: slow (confirmed) speed and inside the GPS drift radius.
  static func isStill(_ p: Point, _ a: Anchor) -> Bool {
    guard let spd = confirmedSpeed(p, a) else { return false }
    let radius = max(15.0, 2.0 * (p.acc ?? 0))
    return spd < stillSpeedMps && distance(a, p) <= radius
  }

  private let prefs: Prefs
  private var suspects: [Point] = []

  init(prefs: Prefs) { self.prefs = prefs }

  /// [previous] is the fix before this one in the same delivery (not on disk yet, so not in lastQueuedT).
  func check(_ p: Point, stoppedIntervalMs: Int64, previous: Int64? = nil) -> Verdict {
    if !p.lat.isFinite || !p.lng.isFinite || abs(p.lat) > 90 || abs(p.lng) > 180 || (p.lat == 0 && p.lng == 0) {
      return .invalid
    }
    let last = prefs.lastQueuedT
    if let previous = previous, p.t <= previous { return .old }
    if p.t <= last && last <= nowMs() + JumpFilter.clockToleranceMs { return .old }
    if p.mock { return .mock }

    let anchor = prefs.anchor
    let silent = anchor == nil || p.t - anchor!.t > JumpFilter.silentMs
    let limit = silent ? JumpFilter.fallbackAccuracyM : JumpFilter.goodAccuracyM
    if (p.acc ?? 0) > limit { return .inaccurate }

    guard let a = anchor else { return .accept }

    if JumpFilter.impliedSpeed(a.t, a.lat, a.lng, p.t, p.lat, p.lng) > JumpFilter.maxSpeedMps {
      if let prev = suspects.last, JumpFilter.impliedSpeed(prev.t, prev.lat, prev.lng, p.t, p.lat, p.lng) <= JumpFilter.maxSpeedMps {
        suspects.append(p)
      } else {
        suspects = [p]
      }
      if suspects.count >= JumpFilter.jumpConfirmations {
        suspects.removeAll()
        return .accept
      }
      return .jump
    }
    suspects.removeAll()

    if JumpFilter.isStill(p, a) && p.t - a.t < stoppedIntervalMs { return .stationarySkip }
    return .accept
  }

  func reset() { suspects.removeAll() }
}
