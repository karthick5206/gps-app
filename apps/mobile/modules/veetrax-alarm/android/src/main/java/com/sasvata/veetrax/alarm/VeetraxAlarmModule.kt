package com.sasvata.veetrax.alarm

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VeetraxAlarmModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("VeetraxAlarm")

    Function("start") { title: String, text: String, alertId: String ->
      AlarmService.start(context, title, text, alertId)
    }

    Function("stop") {
      AlarmService.stop(context)
    }

    /** Android 14+: whether full-screen SOS alerts are allowed for this app. */
    Function("canFullScreen") {
      AlarmService.canFullScreen(context)
    }

    /** Opens Android's "full-screen notifications" setting for this app (app settings before Android 14). */
    Function("openFullScreenSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.packageName))
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(intent) }.onFailure {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    /** The alert whose alarm is ringing now, or null. */
    Function("ringingAlertId") {
      AlarmService.ringingAlert
    }
  }
}
