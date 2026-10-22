package com.sasvata.veetrax.trackerengine

import android.content.Context
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge ("VeetraxTracker"). Thin: it writes prefs, starts / stops the service and forwards to the [Engine].
 * Tracking itself never needs the JS runtime.
 */
class VeetraxTrackerModule : Module() {

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val engine: Engine
    get() = Engine.get(context)

  override fun definition() = ModuleDefinition {
    Name("VeetraxTracker")

    OnCreate {
      appContext.reactContext?.let { CrashLog.install(it) }
    }

    /** Saves credentials + config, sets wanted and starts the service. Returns "started", "no_token", "no_permission" or an error text. */
    AsyncFunction("start") { token: String, serverUrl: String?, config: Map<String, Any?>? ->
      val prefs = engine.prefs
      if (token.isBlank()) return@AsyncFunction "no_token"
      prefs.token = token
      if (!serverUrl.isNullOrBlank()) prefs.serverUrl = serverUrl
      if (config != null) prefs.config = TrackerConfig.merge(prefs.config, config)
      if (!Starter.hasLocationPermission(context)) return@AsyncFunction "no_permission"
      prefs.stopReason = null
      prefs.wanted = true
      WatchdogWorker.schedule(context)
      if (TrackerService.isRunning) {
        engine.post { it.reconfigure() }
        return@AsyncFunction "started"
      }
      if (Starter.start(context, "app")) "started" else (prefs.lastError ?: "Could not start tracking")
    }

    /** The user tapped Stop. Queued points are still uploaded. */
    AsyncFunction("stop") {
      val prefs = engine.prefs
      prefs.wanted = false
      prefs.stopReason = null
      WatchdogWorker.cancel(context)
      Starter.stop(context)
      true
    }

    Function("isRunning") {
      TrackerService.isRunning
    }

    AsyncFunction("getStatus") { promise: Promise ->
      engine.post { promise.resolve(it.status()) }
    }

    AsyncFunction("setConfig") { config: Map<String, Any?> ->
      engine.post { it.applyConfig(TrackerConfig.merge(it.prefs.config, config)) }
      true
    }

    /** Stores the token (after activation) without starting tracking. */
    AsyncFunction("setCredentials") { token: String, serverUrl: String? ->
      engine.prefs.token = token
      if (!serverUrl.isNullOrBlank()) engine.prefs.serverUrl = serverUrl
      true
    }

    /** Fresh fix → queued SOS point → sent alone at once. Resolves "sent" | "queued" | "rejected" | "no_location" | "no_token" | "stopped". */
    AsyncFunction("sendSos") { promise: Promise ->
      engine.sendSos { result -> promise.resolve(result) }
    }

    /** Upload the queue now, ignoring the backoff ("Upload now" button). */
    AsyncFunction("flush") {
      engine.post { it.requestUpload(force = true) }
      true
    }

    /** Clears the INACTIVE stop reason after the server accepts the token again. */
    AsyncFunction("resetStopReason") {
      engine.prefs.stopReason = null
      true
    }

    /** Sign-out: stop and delete token, queue and status. */
    AsyncFunction("clear") { promise: Promise ->
      engine.post {
        it.clearAll()
        promise.resolve(true)
      }
    }

    /** Opens the OEM autostart / background settings screen. Resolves "oem" | "app_details" | "none". */
    AsyncFunction("openAutostartSettings") {
      OemSettings.open(context, appContext.currentActivity)
    }

    /** True when this manufacturer has a known autostart screen (Xiaomi, Oppo, Realme, Vivo, OnePlus, Samsung, …). */
    Function("hasOemAutostart") {
      OemSettings.candidates().isNotEmpty()
    }

    Function("manufacturer") {
      Build.MANUFACTURER ?: ""
    }

    /** The last native crash report (then cleared), or null: the app sends it to the server on start. */
    Function("takeCrash") {
      CrashLog.take(context)
    }

    /** Phone details for crash / support reports. */
    Function("deviceInfo") {
      mapOf("manufacturer" to (Build.MANUFACTURER ?: ""), "model" to (Build.MODEL ?: ""), "android" to (Build.VERSION.RELEASE ?: ""), "sdk" to Build.VERSION.SDK_INT.toDouble())
    }
  }
}
