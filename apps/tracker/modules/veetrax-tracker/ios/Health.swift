import CoreLocation
import Foundation
import UserNotifications

/// Phone settings that decide whether tracking survives in the background, sent with every upload (Android:
/// Health.kt). Only the keys the server knows that mean the same thing on iOS: locOn, locFine (precise location),
/// locBg (location "Always"), powerSave (Low Power Mode), notif. Android-only keys (battOpt, bucket, sdk, ...) are
/// left out. Permission values are cached by the Engine on the main thread.
enum Health {
  static func snapshot(prefs: Prefs, engine: Engine) -> [String: Any] {
    var o: [String: Any] = [:]
    let perms = engine.permissionSnapshot()
    o["locOn"] = CLLocationManager.locationServicesEnabled()
    o["locFine"] = perms.precise
    o["locBg"] = perms.always
    o["powerSave"] = ProcessInfo.processInfo.isLowPowerModeEnabled
    if let notif = perms.notifications { o["notif"] = notif }
    // Tells the server this app delivers the points of a number that moved to another phone before it signs out.
    o["drain"] = true
    o["wanted"] = prefs.wanted
    o["running"] = engine.isRunning
    o["mode"] = engine.mode.rawValue
    o["failures"] = prefs.failures
    if let err = prefs.lastError { o["lastError"] = String(err.prefix(200)) }
    for kind in ["start", "stop", "refused"] {
      if let e = prefs.event(kind) { o[kind] = ["at": NSNumber(value: e.at), "why": e.why] }
    }
    let events = prefs.pendingEvents()
    if !events.isEmpty { o["events"] = events }
    o["mfr"] = "Apple"
    o["model"] = DeviceModel.identifier
    if let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String { o["app"] = v }
    return o
  }
}

enum DeviceModel {
  /// Hardware identifier, e.g. "iPhone15,2".
  static let identifier: String = {
    var info = utsname()
    uname(&info)
    let mirror = Mirror(reflecting: info.machine)
    return mirror.children.reduce(into: "") { s, el in
      if let v = el.value as? Int8, v != 0 { s.append(Character(UnicodeScalar(UInt8(v)))) }
    }
  }()

  static var osVersion: String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
  }
}

/// Uncaught Objective-C exceptions, saved to a file and sent by the app on its next start (Android: CrashLog.kt).
enum CrashLog {
  private static var previous: (@convention(c) (NSException) -> Void)?
  private static var installed = false

  static var file: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
    return dir.appendingPathComponent("veetrax_tracker_crash.txt")
  }

  static func install() {
    guard !installed else { return }
    installed = true
    previous = NSGetUncaughtExceptionHandler()
    NSSetUncaughtExceptionHandler { e in
      let text = "\(e.name.rawValue): \(e.reason ?? "")\n" + e.callStackSymbols.joined(separator: "\n")
      try? FileManager.default.createDirectory(at: CrashLog.file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? String(text.prefix(16_000)).write(to: CrashLog.file, atomically: true, encoding: .utf8)
      CrashLog.previous?(e)
    }
  }

  /// The last crash report, then deleted.
  static func take() -> String? {
    guard let s = try? String(contentsOf: file, encoding: .utf8) else { return nil }
    try? FileManager.default.removeItem(at: file)
    return s.isEmpty ? nil : s
  }
}

/// Local notifications: attendance reminders from the server and "tracking paused" when the app is closed.
enum Notifier {
  static func requestPermission() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
  }

  static func show(id: String, title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
  }

  /// Shown when the user closes the app while tracking: iOS ends location updates until the phone moves on.
  static func showClosed(language: String) {
    let (title, body): (String, String)
    switch language {
    case "hi":
      title = "ट्रैकिंग रुकी हुई है"
      body = "VeeTrax Tracker बंद कर दिया गया। फ़ोन के चलने पर ट्रैकिंग फिर शुरू होगी, या ऐप खोलें।"
    case "ta":
      title = "கண்காணிப்பு இடைநிறுத்தப்பட்டது"
      body = "VeeTrax Tracker மூடப்பட்டது. தொலைபேசி நகரும்போது கண்காணிப்பு மீண்டும் தொடங்கும், அல்லது செயலியைத் திறக்கவும்."
    default:
      title = "Tracking paused"
      body = "VeeTrax Tracker was closed. Tracking resumes when the phone moves, or open the app."
    }
    show(id: "tracking-closed", title: title, body: body)
  }
}
