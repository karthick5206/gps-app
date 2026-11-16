import Foundation
import Security

let DEFAULT_SERVER_URL = "https://gps.mintplus.co.in"

/// Server-controlled tracking settings (API.md `config`). Same defaults and clamps as Android's TrackerConfig.
struct TrackerConfig: Equatable {
  var intervalSec = 10
  var stoppedIntervalSec = 60
  var distanceM = 10
  var maxAccuracyM = 100
  var batchMax = 100

  func clamped() -> TrackerConfig {
    TrackerConfig(
      intervalSec: min(max(intervalSec, 1), 3600),
      stoppedIntervalSec: min(max(stoppedIntervalSec, 10), 3600),
      distanceM: min(max(distanceM, 0), 1000),
      maxAccuracyM: min(max(maxAccuracyM, 1), 10_000),
      batchMax: min(max(batchMax, 1), 500)
    )
  }

  func toDict() -> [String: Any] {
    [
      "intervalSec": intervalSec,
      "stoppedIntervalSec": stoppedIntervalSec,
      "distanceM": distanceM,
      "maxAccuracyM": maxAccuracyM,
      "batchMax": batchMax,
    ]
  }

  private static func num(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber else { return nil }
    let d = n.doubleValue
    return d.isFinite ? Int(d.rounded()) : nil
  }

  /// Merges the keys present in [map] (from JS or the server) over [base].
  static func merge(_ base: TrackerConfig, _ map: [String: Any]?) -> TrackerConfig {
    guard let map = map else { return base }
    return TrackerConfig(
      intervalSec: num(map["intervalSec"]) ?? base.intervalSec,
      stoppedIntervalSec: num(map["stoppedIntervalSec"]) ?? base.stoppedIntervalSec,
      distanceM: num(map["distanceM"]) ?? base.distanceM,
      maxAccuracyM: num(map["maxAccuracyM"]) ?? base.maxAccuracyM,
      batchMax: num(map["batchMax"]) ?? base.batchMax
    ).clamped()
  }
}

/// Last accepted fix: the anchor for the jump / stationary filter.
struct Anchor: Codable {
  let t: Int64
  let lat: Double
  let lng: Double
  let acc: Double
}

/// Values that must survive an app reinstall (install id) or be readable after a reboot in the background (token):
/// kept in the Keychain, readable after the first unlock, never synced off this phone.
enum Keychain {
  private static let service = "com.sasvata.veetrax.trackerengine"

  private static func base(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  static func get(_ key: String) -> String? {
    var q = base(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ key: String, _ value: String?) {
    SecItemDelete(base(key) as CFDictionary)
    guard let value = value, let data = value.data(using: .utf8) else { return }
    var add = base(key)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }
}

/// Everything the engine must remember across relaunches, reboots and app updates (Android: Prefs.kt).
/// UserDefaults is thread-safe; the token lives in the Keychain (cached in memory).
final class Prefs {
  private static let eventQueueMax = 50
  private static let eventWhyMax = 80

  private let d = UserDefaults(suiteName: "veetrax_tracker_engine") ?? .standard
  private let lock = NSLock()
  private var tokenCache: String??

  private func str(_ k: String) -> String? { d.string(forKey: k) }
  private func long(_ k: String) -> Int64 { (d.object(forKey: k) as? NSNumber)?.int64Value ?? 0 }
  private func double(_ k: String) -> Double? { (d.object(forKey: k) as? NSNumber)?.doubleValue }
  private func setLong(_ k: String, _ v: Int64) { d.set(NSNumber(value: v), forKey: k) }

  // ---- credentials & intent ----

  var token: String? {
    get {
      lock.lock(); defer { lock.unlock() }
      if let cached = tokenCache { return cached }
      let v = Keychain.get("token")
      tokenCache = .some(v)
      return v
    }
    set {
      lock.lock(); defer { lock.unlock() }
      let v = (newValue?.isEmpty ?? true) ? nil : newValue
      Keychain.set("token", v)
      tokenCache = .some(v)
    }
  }

  var serverUrl: String {
    get {
      guard let s = str("serverUrl"), !s.trimmingCharacters(in: .whitespaces).isEmpty else { return DEFAULT_SERVER_URL }
      return s
    }
    set {
      var v = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
      while v.hasSuffix("/") { v.removeLast() }
      d.set(v, forKey: "serverUrl")
    }
  }

  /// The user wants tracking on. Only Stop in the app (or a server REVOKED / INVALID / INACTIVE) clears it.
  var wanted: Bool {
    get { d.bool(forKey: "wanted") }
    set { d.set(newValue, forKey: "wanted") }
  }

  /// The company's administrator requires tracking on this phone: Stop is refused.
  var required: Bool {
    get { d.bool(forKey: "required") }
    set { d.set(newValue, forKey: "required") }
  }

  /// This number moved to another phone: tracking is off, the unsent points are still being delivered (then sign-out).
  var revokedDraining: Bool {
    get { d.bool(forKey: "revokedDraining") }
    set { d.set(newValue, forKey: "revokedDraining") }
  }

  /// Why tracking stopped on its own: REVOKED, INVALID or INACTIVE (nil after a user stop).
  var stopReason: String? {
    get { str("stopReason") }
    set { d.set(newValue, forKey: "stopReason") }
  }

  var config: TrackerConfig {
    get { TrackerConfig.merge(TrackerConfig(), d.dictionary(forKey: "config")) }
    set { d.set(newValue.clamped().toDict(), forKey: "config") }
  }

  // ---- filter state ----

  var anchor: Anchor? {
    get {
      guard let data = d.data(forKey: "anchor") else { return nil }
      return try? JSONDecoder().decode(Anchor.self, from: data)
    }
    set {
      if let a = newValue, let data = try? JSONEncoder().encode(a) { d.set(data, forKey: "anchor") } else { d.removeObject(forKey: "anchor") }
    }
  }

  /// Fix time of the newest queued point; every new point must be strictly later (server dedupes on t).
  var lastQueuedT: Int64 {
    get { long("lastQueuedT") }
    set { setLong("lastQueuedT", newValue) }
  }

  // ---- status shown in the app ----

  func recordFix(t: Int64, acc: Double?, spd: Double?) {
    setLong("lastFixAt", t)
    if let acc = acc { d.set(acc, forKey: "lastAcc") } else { d.removeObject(forKey: "lastAcc") }
    if let spd = spd { d.set(spd, forKey: "lastSpd") } else { d.removeObject(forKey: "lastSpd") }
  }

  var lastFixAt: Int64 { long("lastFixAt") }
  var lastAcc: Double? { double("lastAcc") }
  var lastSpd: Double? { double("lastSpd") }

  var lastAcceptedAt: Int64 {
    get { long("lastAcceptedAt") }
    set { setLong("lastAcceptedAt", newValue) }
  }

  var lastUploadAt: Int64 {
    get { long("lastUploadAt") }
    set { setLong("lastUploadAt", newValue) }
  }

  /// Language of the notifications: en, hi or ta, set by the app.
  var language: String {
    get { str("language") ?? "en" }
    set { d.set(newValue, forKey: "language") }
  }

  /// The last attendance notification shown, so each is shown once.
  var lastAttentionId: String? {
    get { str("lastAttentionId") }
    set { d.set(newValue, forKey: "lastAttentionId") }
  }

  var lastError: String? {
    get { str("lastError") }
    set { d.set(newValue, forKey: "lastError") }
  }

  var failures: Int {
    get { d.integer(forKey: "failures") }
    set { d.set(newValue, forKey: "failures") }
  }

  /// Wall-clock ms before which no automatic upload is tried (exponential backoff).
  var backoffUntil: Int64 {
    get { long("backoffUntil") }
    set { setLong("backoffUntil", newValue) }
  }

  /// What asked for the next stop (the Stop button, a server answer, ...); read when tracking ends.
  var stopWhy: String? {
    get { str("stopWhy") }
    set { d.set(newValue, forKey: "stopWhy") }
  }

  /// Phone boot time already reported (Diagnostics).
  var bootAt: Int64 {
    get { long("bootAt") }
    set { setLong("bootAt", newValue) }
  }

  // ---- event history for the server ----

  func recordEvent(_ kind: String, _ why: String, at: Int64 = nowMs()) {
    lock.lock(); defer { lock.unlock() }
    let short = String(why.prefix(Prefs.eventWhyMax))
    var pending = pendingEventsLocked()
    pending.append(["k": kind, "at": at, "why": short])
    if pending.count > Prefs.eventQueueMax { pending.removeFirst(pending.count - Prefs.eventQueueMax) }
    setLong("ev_\(kind)_at", at)
    d.set(short, forKey: "ev_\(kind)_why")
    d.set(pending, forKey: "ev_pending")
  }

  private func pendingEventsLocked() -> [[String: Any]] {
    (d.array(forKey: "ev_pending") as? [[String: Any]]) ?? []
  }

  /// Oldest first; sent with the health report until the server has accepted them.
  func pendingEvents() -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    return pendingEventsLocked()
  }

  func hasPendingEvents() -> Bool { !pendingEvents().isEmpty }

  /// The server accepted the [count] oldest pending events.
  func ackEvents(_ count: Int) {
    guard count > 0 else { return }
    lock.lock(); defer { lock.unlock() }
    var pending = pendingEventsLocked()
    pending.removeFirst(min(count, pending.count))
    d.set(pending, forKey: "ev_pending")
  }

  func event(_ kind: String) -> (at: Int64, why: String)? {
    let at = long("ev_\(kind)_at")
    return at > 0 ? (at, str("ev_\(kind)_why") ?? "") : nil
  }

  func bump(_ counter: String) {
    setLong(counter, long(counter) + 1)
  }

  var mockCount: Int64 { long("mockCount") }
  var droppedCount: Int64 { long("droppedCount") }

  /// Forget everything except the server URL (sign-out, REVOKED, INVALID).
  func clearAll() {
    let url = str("serverUrl")
    for key in d.dictionaryRepresentation().keys { d.removeObject(forKey: key) }
    if let url = url { d.set(url, forKey: "serverUrl") }
    token = nil
  }

  /// Reset upload / filter status (keeps credentials and wanted).
  func clearStatus() {
    for k in ["anchor", "lastQueuedT", "lastFixAt", "lastAcc", "lastSpd", "lastAcceptedAt", "lastUploadAt", "lastError",
              "failures", "backoffUntil", "mockCount", "droppedCount", "revokedDraining"] {
      d.removeObject(forKey: k)
    }
  }
}

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

/// Monotonic milliseconds, including sleep (Android: SystemClock.elapsedRealtime).
func elapsedMs() -> Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }
