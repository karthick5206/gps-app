package com.sasvata.veetrax.alarm

import android.app.ActivityManager
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Every push still goes to Expo's service, which shows the notification. Emergency pushes (the server puts them on the
 * 'sos' channel) also start the looping alarm here, because no JS runs while the app is closed.
 */
class AlarmMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    super.onMessageReceived(remoteMessage)
    val data = remoteMessage.data
    if (data["channelId"] != AlarmService.SOS_CHANNEL) return
    // With the app on screen, JS opens the SOS screen and rings there.
    if (isAppInForeground()) return
    val alertId = runCatching { JSONObject(data["body"] ?: "{}").optString("alertId") }.getOrDefault("")
    // A failed start must not lose the push: its notification is already shown.
    runCatching { AlarmService.start(this, data["title"] ?: "", data["message"] ?: "", alertId) }
      .onFailure { Log.w("VeetraxAlarm", "Alarm not started: ${it.message}") }
  }

  private fun isAppInForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}
