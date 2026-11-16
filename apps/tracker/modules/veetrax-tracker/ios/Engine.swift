import BackgroundTasks
import CoreLocation
import Foundation
import UIKit
import UserNotifications

/// Process-wide tracking engine (Android: Engine.kt + TrackerService.kt + Starter.kt + WatchdogWorker.kt).
///
/// Threads: CLLocationManager lives on the main thread (its delegate calls arrive there); everything else (filter,
/// SQLite queue, HTTP upload, mode switching, SOS bookkeeping) runs on ONE serial queue, so there is no locking of
/// engine state. Works without the JS runtime: iOS relaunches the app in the background after a significant move,
/// and the app delegate subscriber resumes tracking from here.
///
/// iOS specifics:
///  - Background: `allowsBackgroundLocationUpdates` keeps the app running while updates are on (blue indicator).
///    Significant-change monitoring relaunches the app after it was closed or killed; then updates start again.
///  - No intervals in CLLocationManager: fixes are thinned here to intervalSec (moving) / stoppedIntervalSec.
///  - MOVING = best accuracy with the distance filter; STATIONARY = ~100 m accuracy (Wi-Fi / cell, GPS mostly off),
///    no distance filter, plus a short GPS probe every 3 minutes (same rules as Android).
///  - Watchdog: a BGAppRefreshTask (~15 min, at iOS's discretion) asks the server whether tracking is required while
///    it is off, and sends a health report when nothing else reached the server for a while.
final class Engine: NSObject, CLLocationManagerDelegate {
  static let shared = Engine()

  enum Mode: String { case moving, stationary }

  static let watchdogTaskId = "com.sasvata.veetrax.tracker.watchdog"

  private static let stillToStationaryMs: Int64 = 2 * 60_000
  private static let noFixToStationaryMs: Int64 = 2 * 60_000
  private static let idleCheckSec = 60
  private static let stationaryGpsProbeMs: Int64 = 3 * 60_000
  private static let probeTimeoutSec: TimeInterval = 15
  private static let uploadGapMovingMs: Int64 = 20_000
  private static let uploadGapStationaryMs: Int64 = 60_000
  private static let moveSpeedMps = 2.0
  private static let moveMinDistanceM = 30.0
  private static let sosTimeoutSec: TimeInterval = 15
  private static let sosMaxAgeSec: TimeInterval = 10
  private static let trimEventGapMs: Int64 = 60 * 60_000
  private static let pingAfterMs: Int64 = 10 * 60_000
  private static let watchdogEverySec: TimeInterval = 15 * 60
  private static let bootToleranceMs: Int64 = 5 * 60_000

  let prefs = Prefs()
  private let pointQueue = PointQueue()
  private lazy var filter = JumpFilter(prefs: prefs)
  private lazy var uploader: Uploader = makeUploader()
  /// The engine queue: all engine state below is touched only here.
  let q = DispatchQueue(label: "veetrax-tracker", qos: .utility)

  // ---- shared between main and the engine queue (lock) ----
  private let stateLock = NSLock()
  private var _running = false
  private var _mode: Mode = .moving
  private var _perms = PermissionSnapshot(always: false, whenInUse: false, precise: true, notifications: nil)

  struct PermissionSnapshot {
    var always: Bool
    var whenInUse: Bool
    var precise: Bool
    var notifications: Bool?
    var any: Bool { always || whenInUse }
  }

  var isRunning: Bool {
    stateLock.lock(); defer { stateLock.unlock() }
    return _running
  }

  private(set) var mode: Mode {
    get { stateLock.lock(); defer { stateLock.unlock() }; return _mode }
    set { stateLock.lock(); _mode = newValue; stateLock.unlock() }
  }

  func permissionSnapshot() -> PermissionSnapshot {
    stateLock.lock(); defer { stateLock.unlock() }
    return _perms
  }

  private func setRunning(_ v: Bool) {
    stateLock.lock(); _running = v; stateLock.unlock()
  }

  // ---- engine queue state ----
  private var stillSince: Int64?
  private var lastRawFixElapsed: Int64 = 0
  private var lastProbeElapsed: Int64 = 0
  private var lastUploadElapsed: Int64 = 0
  private var lastTrimEventElapsed: Int64 = 0
  /// Fix time of the last fix taken from the stream (thinning to the configured interval).
  private var lastTakenT: Int64 = 0
  private var uploadWork: DispatchWorkItem?
  private var idleTimer: DispatchSourceTimer?

  // ---- main thread state ----
  private var manager: CLLocationManager?
  /// One-shot fixes (SOS, the stationary GPS probe), independent of the tracking stream.
  private var oneShot: CLLocationManager?
  private var oneShotWaiters: [(CLLocation?) -> Void] = []
  private var oneShotTimeout: DispatchWorkItem?
  private var backgroundSession: AnyObject?
  private var battery = BatteryInfo()

  private override init() {
    super.init()
    if Thread.isMainThread { setUpManagers() } else { DispatchQueue.main.async { self.setUpManagers() } }
  }

  private func makeUploader() -> Uploader {
    let u = Uploader(prefs: prefs, queue: pointQueue)
    u.health = { [unowned self] in
      var h = Health.snapshot(prefs: self.prefs, engine: self)
      h["queue"] = NSNumber(value: self.pointQueue.size())
      if self.prefs.lastFixAt > 0 { h["lastFixAt"] = NSNumber(value: self.prefs.lastFixAt) }
      return h
    }
    u.onConfig = { [unowned self] cfg in self.applyConfig(TrackerConfig.merge(self.prefs.config, cfg)) }
    u.onRequired = { [unowned self] required in self.applyRequired(required) }
    u.onRevoked = { [unowned self] in self.startRevokedDrain() }
    u.onAttention = { [unowned self] id, title, text in
      if self.prefs.lastAttentionId != id {
        self.prefs.lastAttentionId = id
        Notifier.show(id: "attention-\(id)", title: title, body: text)
      }
    }
    pointQueue.onTrimmed = { [unowned self] dropped in
      if self.lastTrimEventElapsed == 0 || elapsedMs() - self.lastTrimEventElapsed > Engine.trimEventGapMs {
        self.lastTrimEventElapsed = elapsedMs()
        self.prefs.recordEvent("upload", "queue full: oldest \(dropped) points dropped")
      }
    }
    return u
  }

  /// Runs [block] on the engine queue; an error never kills the queue.
  func post(_ block: @escaping (Engine) -> Void) {
    q.async { block(self) }
  }

  // ================================================================ app lifecycle (main)

  /// Called once from the app delegate subscriber at launch (also a background relaunch after a significant move).
  func boot(launchedForLocation: Bool) {
    CrashLog.install()
    registerWatchdog()
    refreshNotificationPermission()
    post { e in
      e.recordBoot()
      if !(e.prefs.token ?? "").isEmpty { e.scheduleWatchdog() }
      e.requestUpload(force: false)
    }
    ensureRunning(why: launchedForLocation ? "relaunched by iOS (phone moved)" : "app launch")
  }

  /// The user closed the app from the app switcher. iOS ends location updates now; the significant-change monitor
  /// relaunches the app when the phone moves on.
  func appWillTerminate() {
    guard isRunning, prefs.wanted else { return }
    prefs.recordEvent("stop", "app closed from the app switcher; resumes when the phone moves")
    Notifier.showClosed(language: prefs.language)
  }

  func appDidBecomeActive() {
    refreshNotificationPermission()
    if let m = manager { readPermissions(m) }
  }

  private func refreshNotificationPermission() {
    UNUserNotificationCenter.current().getNotificationSettings { s in
      let on: Bool
      switch s.authorizationStatus {
      case .authorized, .provisional, .ephemeral: on = true
      default: on = false
      }
      self.stateLock.lock(); self._perms.notifications = on; self.stateLock.unlock()
    }
  }

  /// A phone restart shows up as a gap; record it so the server can explain it (Android: Diagnostics.recordBoot).
  private func recordBoot() {
    let bootAt = nowMs() - Int64(ProcessInfo.processInfo.systemUptime * 1000)
    let known = prefs.bootAt
    if known != 0 && abs(bootAt - known) <= Engine.bootToleranceMs { return }
    prefs.bootAt = bootAt
    if known != 0 { prefs.recordEvent("boot", "phone restarted", at: bootAt) }
  }

  // ================================================================ location manager (main)

  private func setUpManagers() {
    let m = CLLocationManager()
    m.delegate = self
    m.pausesLocationUpdatesAutomatically = false
    m.activityType = .otherNavigation
    manager = m
    let one = CLLocationManager()
    one.delegate = self
    one.desiredAccuracy = kCLLocationAccuracyBest
    oneShot = one
    readPermissions(m)
    battery = Battery.read()
  }

  private func readPermissions(_ m: CLLocationManager) {
    let status = m.authorizationStatus
    stateLock.lock()
    _perms.always = status == .authorizedAlways
    _perms.whenInUse = status == .authorizedWhenInUse
    _perms.precise = m.accuracyAuthorization == .fullAccuracy
    stateLock.unlock()
  }

  func hasLocationPermission() -> Bool { permissionSnapshot().any }

  /// Starts location updates if tracking should run and isn't running (Android: Starter.ensureRunning). Any thread.
  func ensureRunning(why: String) {
    if !Thread.isMainThread {
      DispatchQueue.main.async { self.ensureRunning(why: why) }
      return
    }
    guard prefs.wanted, !(prefs.token ?? "").isEmpty, !isRunning else { return }
    _ = startUpdates(why: why)
  }

  /// Main thread. Returns true when tracking is (now) running.
  @discardableResult
  private func startUpdates(why: String) -> Bool {
    guard let m = manager else { return false }
    readPermissions(m)
    let perms = permissionSnapshot()
    if !perms.any {
      prefs.lastError = "Location permission is off. Open the app and allow location."
      prefs.recordEvent("refused", "\(why): no location permission")
      return false
    }
    if !perms.always && UIApplication.shared.applicationState == .background {
      prefs.lastError = "Tracking paused: allow location \"Always\" so it can restart in the background. Open the app."
      prefs.recordEvent("refused", "\(why): location not allowed Always")
      return false
    }
    m.allowsBackgroundLocationUpdates = true
    m.pausesLocationUpdatesAutomatically = false
    m.showsBackgroundLocationIndicator = true
    applyModeSettings(m)
    if #available(iOS 17.0, *), backgroundSession == nil {
      // Keeps "While Using" permission working in the background for as long as tracking runs.
      backgroundSession = CLBackgroundActivitySession()
    }
    m.startUpdatingLocation()
    m.startMonitoringSignificantLocationChanges()
    if !isRunning {
      setRunning(true)
      prefs.recordEvent("start", why)
      post { $0.onStarted() }
    }
    return true
  }

  /// Main thread. Ends tracking; [record] = this run ended (start/stop history).
  private func stopUpdates() {
    guard let m = manager else { return }
    m.stopUpdatingLocation()
    m.stopMonitoringSignificantLocationChanges()
    if #available(iOS 17.0, *) {
      (backgroundSession as? CLBackgroundActivitySession)?.invalidate()
    }
    backgroundSession = nil
    if isRunning {
      setRunning(false)
      prefs.recordEvent("stop", prefs.wanted ? "stopped by iOS while tracking" : (prefs.stopWhy ?? prefs.stopReason ?? "stopped, cause not recorded"))
      post { $0.onStopped() }
    }
  }

  /// Main thread. Accuracy / distance filter for the current mode.
  private func applyModeSettings(_ m: CLLocationManager) {
    let cfg = prefs.config
    switch mode {
    case .moving:
      m.desiredAccuracy = kCLLocationAccuracyBest
      m.distanceFilter = cfg.distanceM > 0 ? CLLocationDistance(cfg.distanceM) : kCLDistanceFilterNone
    case .stationary:
      m.desiredAccuracy = kCLLocationAccuracyHundredMeters
      m.distanceFilter = kCLDistanceFilterNone
    }
  }

  func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    battery = Battery.read()
    if m === oneShot {
      finishOneShot(locations.last)
      return
    }
    guard isRunning, !locations.isEmpty else { return }
    let bat = battery
    post { $0.onLocations(locations, battery: bat, probe: false) }
  }

  func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
    let code = (error as? CLError)?.code
    if m === oneShot {
      finishOneShot(nil)
      return
    }
    if code == .denied {
      prefs.lastError = "Location permission is off. Open the app and allow location."
    }
  }

  func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
    guard m === manager else { return }
    readPermissions(m)
    if hasLocationPermission() {
      ensureRunning(why: "location allowed")
    } else if isRunning {
      prefs.lastError = "Location permission is off. Open the app and allow location."
      prefs.recordEvent("stop", "location permission withdrawn")
    }
  }

  /// Main thread. One fresh fix within [timeout], or nil. A recent enough cached fix answers at once.
  private func requestOneFix(timeout: TimeInterval, maxAge: TimeInterval, _ done: @escaping (CLLocation?) -> Void) {
    if maxAge > 0, let cached = [manager?.location, oneShot?.location].compactMap({ $0 }).max(by: { $0.timestamp < $1.timestamp }),
      -cached.timestamp.timeIntervalSinceNow <= maxAge, cached.horizontalAccuracy >= 0
    {
      done(cached)
      return
    }
    guard let one = oneShot, hasLocationPermission() else {
      done(nil)
      return
    }
    oneShotWaiters.append(done)
    if oneShotWaiters.count > 1 { return }
    one.requestLocation()
    let timeoutWork = DispatchWorkItem { [weak self] in self?.finishOneShot(nil) }
    oneShotTimeout = timeoutWork
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timeoutWork)
  }

  private func finishOneShot(_ loc: CLLocation?) {
    oneShotTimeout?.cancel()
    oneShotTimeout = nil
    let waiters = oneShotWaiters
    oneShotWaiters.removeAll()
    for w in waiters { w(loc) }
  }

  // ================================================================ engine queue: tracking lifecycle

  private func onStarted() {
    mode = .moving
    stillSince = nil
    lastRawFixElapsed = elapsedMs()
    lastTakenT = 0
    filter.reset()
    startIdleTimer()
    requestUpload(force: true)
  }

  private func onStopped() {
    idleTimer?.cancel()
    idleTimer = nil
    // Points recorded before Stop are still sent (normal coalescing / backoff).
    requestUpload(force: false)
  }

  /// Re-applies the location settings (after a config change).
  func reconfigure() {
    DispatchQueue.main.async {
      if let m = self.manager, self.isRunning { self.applyModeSettings(m) }
    }
  }

  func applyConfig(_ next: TrackerConfig) {
    let prev = prefs.config
    prefs.config = next
    if prev.intervalSec != next.intervalSec || prev.distanceM != next.distanceM || prev.stoppedIntervalSec != next.stoppedIntervalSec {
      reconfigure()
    }
  }

  /// The server's answer: when tracking is required and off, it comes back on (not after REVOKED / INACTIVE).
  private func applyRequired(_ required: Bool) {
    prefs.required = required
    guard required, !prefs.wanted, !(prefs.token ?? "").isEmpty, prefs.stopReason == nil else { return }
    prefs.stopWhy = nil
    prefs.wanted = true
    scheduleWatchdog()
    ensureRunning(why: "required by the server")
  }

  /// Stops recording, keeps the token until the queue has been delivered (the next empty drain signs out).
  private func startRevokedDrain() {
    if prefs.revokedDraining { return }
    prefs.revokedDraining = true
    prefs.required = false
    prefs.stopWhy = "moved to another phone"
    prefs.wanted = false
    DispatchQueue.main.async { self.stopUpdates() }
  }

  /// "Phone off" vs "no GPS": a short report when nothing reached the server for a while. Blocks for the HTTP call.
  func ping() {
    guard let token = prefs.token else { return }
    if pointQueue.size() > 0 || prefs.revokedDraining { return requestUpload(force: false) }
    if nowMs() - prefs.lastUploadAt < Engine.pingAfterMs || nowMs() < prefs.backoffUntil { return }
    let o = uploader.send(token: token, batch: [])
    if case .stop = o, prefs.token == token { stopFromServer(o) }
  }

  /// Sign-out: delivers what can be delivered first. Returns how many points are still waiting.
  func uploadNow() -> Int64 {
    runUpload()
    return pointQueue.size()
  }

  /// Watchdog, while tracking is off: asks whether it must be on. Blocks for the HTTP call.
  func checkRequired() {
    if prefs.wanted { return }
    guard let token = prefs.token else { return }
    if prefs.revokedDraining { return requestUpload(force: false) }
    if let required = uploader.fetchRequired(token: token) { applyRequired(required) }
  }

  private func startIdleTimer() {
    idleTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .seconds(Engine.idleCheckSec), repeating: .seconds(Engine.idleCheckSec), leeway: .seconds(10))
    t.setEventHandler { [weak self] in self?.idleCheck() }
    t.resume()
    idleTimer = t
  }

  private func idleCheck() {
    guard isRunning else { return }
    if mode == .moving && elapsedMs() - lastRawFixElapsed > Engine.noFixToStationaryMs { setMode(.stationary) }
    if mode == .stationary && elapsedMs() - lastProbeElapsed >= Engine.stationaryGpsProbeMs { probeGps() }
    requestUpload(force: false)
    ping()
  }

  /// Parked, the phone gives only Wi-Fi / cell positions; one short GPS reading every few minutes catches a drive.
  private func probeGps() {
    lastProbeElapsed = elapsedMs()
    DispatchQueue.main.async {
      self.requestOneFix(timeout: Engine.probeTimeoutSec, maxAge: 0) { loc in
        guard let loc = loc, self.isRunning else { return }
        let bat = self.battery
        self.post { $0.onLocations([loc], battery: bat, probe: true) }
      }
    }
  }

  private func setMode(_ next: Mode) {
    if mode == next { return }
    mode = next
    stillSince = nil
    reconfigure()
  }

  // ================================================================ engine queue: fixes

  private func onLocations(_ locations: [CLLocation], battery: BatteryInfo, probe: Bool) {
    let cfg = prefs.config
    var queued: [Point] = []
    for loc in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
      lastRawFixElapsed = elapsedMs()
      let p0 = Point.from(loc, battery: battery, mode: mode.rawValue)
      // iOS has no update interval: take one fix per configured interval (a probe always counts).
      let gapMs = Int64((mode == .moving ? cfg.intervalSec : cfg.stoppedIntervalSec) * 1000) - 500
      if !probe && lastTakenT > 0 && p0.t - lastTakenT < gapMs && p0.t >= lastTakenT { continue }
      lastTakenT = p0.t
      prefs.recordFix(t: p0.t, acc: p0.acc, spd: p0.spd)
      updateMode(p0, prefs.anchor)
      var label: String?
      switch filter.check(p0, stoppedIntervalMs: Int64(cfg.stoppedIntervalSec) * 1000, previous: queued.last?.t) {
      case .accept:
        prefs.anchor = Anchor(t: p0.t, lat: p0.lat, lng: p0.lng, acc: p0.acc ?? 0)
        prefs.lastAcceptedAt = p0.t
        label = nil
      case .mock:
        label = "mock"
        prefs.bump("mockCount")
      case .inaccurate:
        label = "inaccurate"
        prefs.bump("droppedCount")
      case .jump:
        label = "jump"
        prefs.bump("droppedCount")
      case .stationarySkip:
        label = "still"
      case .invalid, .old:
        continue
      }
      var p = p0
      p.flt = label
      queued.append(p)
    }
    if !queued.isEmpty {
      pointQueue.add(queued)
      prefs.lastQueuedT = queued.last!.t
      requestUpload(force: false)
    }
  }

  private func updateMode(_ p: Point, _ anchor: Anchor?) {
    if p.mock { return }
    let acc = p.acc ?? 0
    if acc > JumpFilter.fallbackAccuracyM { return }
    let fast = (JumpFilter.confirmedSpeed(p, anchor) ?? 0) > Engine.moveSpeedMps
    let far = anchor.map { JumpFilter.distance($0, p) > max(Engine.moveMinDistanceM, 2 * acc) } ?? false
    switch mode {
    case .stationary:
      if fast || far { setMode(.moving) }
    case .moving:
      if let a = anchor, JumpFilter.isStill(p, a) {
        let since = stillSince ?? p.t
        stillSince = since
        if p.t - since >= Engine.stillToStationaryMs { setMode(.stationary) }
      } else {
        stillSince = nil
      }
    }
  }

  // ================================================================ engine queue: upload

  /// Schedules an upload: at once when [force], otherwise after the coalescing gap and the backoff.
  func requestUpload(force: Bool) {
    guard !(prefs.token ?? "").isEmpty,
      pointQueue.size() > 0 || prefs.hasPendingEvents() || prefs.revokedDraining
    else { return }
    uploadWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.runUpload() }
    uploadWork = work
    if force {
      q.async(execute: work)
      return
    }
    let gap = mode == .stationary ? Engine.uploadGapStationaryMs : Engine.uploadGapMovingMs
    let byGap = lastUploadElapsed == 0 ? 0 : lastUploadElapsed + gap - elapsedMs()
    let byBackoff = prefs.backoffUntil - nowMs()
    let delayMs = max(0, max(byGap, byBackoff))
    q.asyncAfter(deadline: .now() + .milliseconds(Int(delayMs)), execute: work)
  }

  private func runUpload() {
    lastUploadElapsed = elapsedMs()
    let used = prefs.token
    let o = uploader.drain()
    switch o {
    case .stop:
      // A 401 for a token that was replaced meanwhile (re-activation) must not sign out the new one.
      if prefs.token == used { stopFromServer(o) }
    case .retry:
      requestUpload(force: false)
    case .done:
      break
    }
  }

  /// 401 REVOKED / INVALID: stop, clear token & queue. 403 INACTIVE: stop, keep the token.
  private func stopFromServer(_ o: Uploader.Outcome) {
    guard case let .stop(reason, clearToken) = o else { return }
    prefs.stopWhy = "server answered \(reason)"
    prefs.wanted = false
    prefs.stopReason = reason
    uploadWork?.cancel()
    if clearToken {
      prefs.token = nil
      pointQueue.clear()
      prefs.clearStatus()
      filter.reset()
    }
    cancelWatchdog()
    DispatchQueue.main.async { self.stopUpdates() }
  }

  // ================================================================ JS-facing operations (engine queue unless noted)

  /// Any thread. Returns "started", "no_permission" or an error text.
  func start(token: String, serverUrl: String?, config: [String: Any]?, done: @escaping (String) -> Void) {
    if token.isEmpty { return done("no_token") }
    prefs.token = token
    if let url = serverUrl, !url.trimmingCharacters(in: .whitespaces).isEmpty { prefs.serverUrl = url }
    if let config = config { prefs.config = TrackerConfig.merge(prefs.config, config) }
    DispatchQueue.main.async {
      if let m = self.manager { self.readPermissions(m) }
      guard self.hasLocationPermission() else { return done("no_permission") }
      Notifier.requestPermission()
      self.prefs.stopReason = nil
      self.prefs.stopWhy = nil
      self.prefs.wanted = true
      self.post { $0.scheduleWatchdog() }
      if self.isRunning {
        self.reconfigure()
        return done("started")
      }
      done(self.startUpdates(why: "app") ? "started" : (self.prefs.lastError ?? "Could not start tracking"))
    }
  }

  /// Any thread. The Stop button can't turn off tracking the administrator requires; a server check still can.
  func stop(why: String?) -> Bool {
    if prefs.required && !(why?.hasPrefix("server") ?? false) { return false }
    prefs.stopWhy = why ?? "app (no reason given)"
    prefs.wanted = false
    prefs.stopReason = nil
    DispatchQueue.main.async { self.stopUpdates() }
    return true
  }

  /// Sign-out: stop and forget everything (token, queue, status).
  func clearAll() {
    prefs.wanted = false
    prefs.stopWhy = "signed out"
    uploadWork?.cancel()
    cancelWatchdog()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      self.stopUpdates()
      done.signal()
    }
    _ = done.wait(timeout: .now() + 2)
    pointQueue.clear()
    filter.reset()
    prefs.clearAll()
    prefs.stopWhy = "signed out"
  }

  /// SOS: a fresh accurate fix (up to 15 s), else the last known one; queued with sos=true and a time strictly after
  /// the last queued point, then sent alone at once, ignoring the backoff.
  func sendSos(done: @escaping (String) -> Void) {
    guard let token = prefs.token, !token.isEmpty else { return done("no_token") }
    DispatchQueue.main.async {
      guard self.hasLocationPermission() else { return done("no_location") }
      self.requestOneFix(timeout: Engine.sosTimeoutSec, maxAge: Engine.sosMaxAgeSec) { fresh in
        let loc = fresh ?? self.manager?.location ?? self.oneShot?.location
        guard let loc = loc else { return done("no_location") }
        let bat = self.battery
        self.post { e in done(e.finishSos(token: token, loc: loc, battery: bat)) }
      }
    }
  }

  private func finishSos(token: String, loc: CLLocation, battery: BatteryInfo) -> String {
    var p = Point.from(loc, battery: battery, sos: true)
    p.t = max(p.t, prefs.lastQueuedT + 1)
    pointQueue.add([p]) // safe even if the upload below fails or the app is killed
    prefs.lastQueuedT = p.t
    let o = uploader.send(token: token, batch: [p])
    switch o {
    case .done:
      pointQueue.remove([p.t])
      requestUpload(force: false)
      return "sent"
    case .stop:
      stopFromServer(o)
      return "stopped"
    case .retry:
      requestUpload(force: false)
      return "queued"
    }
  }

  func status() -> [String: Any] {
    func time(_ v: Int64) -> Any { v > 0 ? NSNumber(value: Double(v)) : NSNull() }
    func opt(_ v: Any?) -> Any { v ?? NSNull() }
    let cfg = prefs.config
    return [
      "running": isRunning,
      "wanted": prefs.wanted,
      "hasToken": !(prefs.token ?? "").isEmpty,
      "serverUrl": prefs.serverUrl,
      "mode": mode.rawValue,
      "lastFixAt": time(prefs.lastFixAt),
      "lastAcc": opt(prefs.lastAcc),
      "lastSpd": opt(prefs.lastSpd),
      "lastAcceptedAt": time(prefs.lastAcceptedAt),
      "lastUploadAt": time(prefs.lastUploadAt),
      "lastError": opt(prefs.lastError),
      "failures": Double(prefs.failures),
      "backoffUntil": time(prefs.backoffUntil),
      "queueSize": Double(pointQueue.size()),
      "mockCount": Double(prefs.mockCount),
      "droppedCount": Double(prefs.droppedCount),
      "stopReason": opt(prefs.stopReason),
      "required": prefs.required,
      "config": [
        "intervalSec": Double(cfg.intervalSec),
        "stoppedIntervalSec": Double(cfg.stoppedIntervalSec),
        "distanceM": Double(cfg.distanceM),
        "maxAccuracyM": Double(cfg.maxAccuracyM),
        "batchMax": Double(cfg.batchMax),
      ],
    ]
  }

  // ================================================================ watchdog (BGAppRefreshTask)

  private var watchdogRegistered = false

  /// Main thread, during launch. Only when Info.plist permits the id (registering an unlisted id crashes).
  private func registerWatchdog() {
    guard !watchdogRegistered else { return }
    let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    guard permitted.contains(Engine.watchdogTaskId) else { return }
    watchdogRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: Engine.watchdogTaskId, using: nil) { task in
      Engine.shared.runWatchdog(task)
    }
  }

  func scheduleWatchdog() {
    guard watchdogRegistered else { return }
    let req = BGAppRefreshTaskRequest(identifier: Engine.watchdogTaskId)
    req.earliestBeginDate = Date(timeIntervalSinceNow: Engine.watchdogEverySec)
    try? BGTaskScheduler.shared.submit(req)
  }

  private func cancelWatchdog() {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Engine.watchdogTaskId)
  }

  private func runWatchdog(_ task: BGTask) {
    var finished = false
    let finish: (Bool) -> Void = { ok in
      self.q.async {
        if finished { return }
        finished = true
        task.setTaskCompleted(success: ok)
      }
    }
    task.expirationHandler = { finish(false) }
    post { e in
      if !(e.prefs.token ?? "").isEmpty {
        e.scheduleWatchdog()
        if e.prefs.wanted {
          e.ensureRunning(why: "watchdog")
          e.ping()
        } else {
          e.checkRequired()
        }
      }
      finish(true)
    }
  }
}
