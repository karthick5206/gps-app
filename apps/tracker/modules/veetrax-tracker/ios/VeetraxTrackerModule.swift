import ExpoModulesCore
import UIKit

/// JS bridge ("VeetraxTracker"), the same API as the Android module. Thin: it forwards to the [Engine].
/// Tracking itself never needs the JS runtime.
public class VeetraxTrackerModule: Module {
  private var engine: Engine { Engine.shared }

  public func definition() -> ModuleDefinition {
    Name("VeetraxTracker")

    OnCreate {
      CrashLog.install()
    }

    /// Saves credentials + config, sets wanted and starts tracking. Resolves "started", "no_token", "no_permission" or an error text.
    AsyncFunction("start") { (token: String, serverUrl: String?, config: [String: Any]?, promise: Promise) in
      self.engine.start(token: token, serverUrl: serverUrl, config: config) { promise.resolve($0) }
    }

    /// Stops tracking; [why] says what asked for it. Queued points are still uploaded.
    AsyncFunction("stop") { (why: String?) -> Bool in
      self.engine.stop(why: why)
    }

    Function("isRunning") { () -> Bool in
      self.engine.isRunning
    }

    AsyncFunction("getStatus") { (promise: Promise) in
      self.engine.post { promise.resolve($0.status()) }
    }

    AsyncFunction("setConfig") { (config: [String: Any]) -> Bool in
      self.engine.post { $0.applyConfig(TrackerConfig.merge($0.prefs.config, config)) }
      return true
    }

    /// Stores the token (after activation) without starting tracking.
    /// The server address in use: the stored one if any, else buildUrl (then stored). Same as Android.
    AsyncFunction("initServerUrl") { (buildUrl: String?) -> String in
      let prefs = self.engine.prefs
      if !prefs.hasServerUrl, let url = buildUrl, !url.trimmingCharacters(in: .whitespaces).isEmpty { prefs.serverUrl = url }
      return prefs.serverUrl
    }
    /// Activation screen "Demo account" (live / demo server), before activation.
    AsyncFunction("setServerUrl") { (url: String) -> String in
      if !url.trimmingCharacters(in: .whitespaces).isEmpty { self.engine.prefs.serverUrl = url }
      return self.engine.prefs.serverUrl
    }
    AsyncFunction("setCredentials") { (token: String, serverUrl: String?) -> Bool in
      self.engine.prefs.token = token
      if let url = serverUrl, !url.isEmpty { self.engine.prefs.serverUrl = url }
      return true
    }

    /// Fresh fix → queued SOS point → sent alone at once.
    AsyncFunction("sendSos") { (promise: Promise) in
      self.engine.sendSos { promise.resolve($0) }
    }

    /// Upload the queue now, ignoring the backoff ("Upload now" button).
    AsyncFunction("flush") { () -> Bool in
      self.engine.post { $0.requestUpload(force: true) }
      return true
    }

    /// Delivers the queue before signing out; resolves with how many points could not be sent.
    AsyncFunction("uploadNow") { (promise: Promise) in
      self.engine.post { promise.resolve(Double($0.uploadNow())) }
    }

    /// Clears the INACTIVE stop reason after the server accepts the token again.
    AsyncFunction("resetStopReason") { () -> Bool in
      self.engine.prefs.stopReason = nil
      return true
    }

    /// Sign-out: stop and delete token, queue and status.
    AsyncFunction("clear") { (promise: Promise) in
      self.engine.post {
        $0.clearAll()
        promise.resolve(true)
      }
    }

    /// No phone-maker autostart screens on iOS: opens this app's page in Settings.
    AsyncFunction("openAutostartSettings") { () -> String in
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return "none" }
      UIApplication.shared.open(url)
      return "app_details"
    }.runOnQueue(.main)

    Function("hasOemAutostart") { () -> Bool in
      false
    }

    Function("manufacturer") { () -> String in
      "Apple"
    }

    /// The last native crash report (then cleared), or nil: the app sends it to the server on start.
    Function("takeCrash") { () -> String? in
      CrashLog.take()
    }

    /// Stable id for this app on this phone, kept in the Keychain so it survives a reinstall (restores the activation).
    Function("installId") { () -> String in
      if let id = Keychain.get("installId"), !id.isEmpty { return id }
      let id = UUID().uuidString.lowercased()
      Keychain.set("installId", id)
      return id
    }

    /// The language for the notifications shown here.
    Function("setLanguage") { (code: String) in
      self.engine.prefs.language = code
    }

    /// The token the engine keeps for uploads (survives an update even if the app's secure storage did not).
    Function("savedToken") { () -> String in
      self.engine.prefs.token ?? ""
    }

    /// Phone details for crash / support reports (the "android" key carries the iOS version, for the shared type).
    Function("deviceInfo") { () -> [String: Any] in
      ["manufacturer": "Apple", "model": DeviceModel.identifier, "android": DeviceModel.osVersion, "sdk": 0]
    }
  }
}

/// App lifecycle hooks: resumes tracking at launch (including a background relaunch after a significant move) and
/// registers the watchdog, which iOS requires before launch finishes.
public class VeetraxTrackerAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    Engine.shared.boot(launchedForLocation: launchOptions?[.location] != nil)
    return true
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    Engine.shared.appDidBecomeActive()
  }

  public func applicationWillTerminate(_ application: UIApplication) {
    Engine.shared.appWillTerminate()
  }
}
