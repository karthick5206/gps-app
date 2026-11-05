package com.sasvata.veetrax.alarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * The loud emergency alarm: loops the siren on the alarm volume, so it also rings on a silent phone, until someone
 * silences it or opens the alert. The notification opens the SOS screen, over the lock screen where Android allows it.
 */
class AlarmService : Service() {
  private var player: MediaPlayer? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var savedVolume: Int? = null
  private val handler = Handler(Looper.getMainLooper())
  private val stopLater = Runnable { stopSelf() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = buildNotification(intent?.getStringExtra(EXTRA_TITLE).orEmpty(), intent?.getStringExtra(EXTRA_TEXT).orEmpty(), intent?.getStringExtra(EXTRA_ALERT).orEmpty())
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    ring()
    handler.removeCallbacks(stopLater)
    handler.postDelayed(stopLater, MAX_RING_MS)
    return START_NOT_STICKY
  }

  private fun ring() {
    if (player != null) return
    wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "veetrax:alarm")
      .apply { acquire(MAX_RING_MS + 5_000) }
    // Android may refuse this under Do Not Disturb; the alarm then rings at the volume it has.
    val audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    runCatching {
      val before = audio.getStreamVolume(AudioManager.STREAM_ALARM)
      audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
      savedVolume = before
    }
    player = runCatching {
      MediaPlayer().apply {
        setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        setDataSource(this@AlarmService, sirenUri())
        isLooping = true
        prepare()
        start()
      }
    }.getOrNull()
    (getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)?.let { vibrator ->
      vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 400, 800, 400, 800), 0), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
    }
  }

  /** The siren bundled for the 'sos' notification channel, else the phone's own alarm sound. */
  private fun sirenUri(): Uri {
    val id = resources.getIdentifier("sos_siren", "raw", packageName)
    return if (id != 0) Uri.parse("android.resource://$packageName/$id") else RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
  }

  private fun buildNotification(title: String, text: String, alertId: String): Notification {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // Silent channel: the sound comes from this service, on the alarm volume.
    nm.createNotificationChannel(NotificationChannel(RING_CHANNEL, getString(R.string.veetrax_alarm_channel), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setBypassDnd(true)
    })
    val test = alertId == "test"
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("veetrax:///sos/${if (alertId.isEmpty()) "unknown" else alertId}${if (test) "?test=1" else ""}")).apply {
      setPackage(packageName)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val content = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val silence = PendingIntent.getService(this, 3, Intent(this, AlarmService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this, RING_CHANNEL)
      .setSmallIcon(applicationInfo.icon)
      .setColor(0xFFC62828.toInt())
      .setContentTitle(title.ifEmpty { getString(R.string.veetrax_alarm_channel) })
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setContentIntent(content)
      .setFullScreenIntent(content, true)
      .addAction(0, getString(R.string.veetrax_alarm_silence), silence)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  override fun onDestroy() {
    handler.removeCallbacks(stopLater)
    runCatching { player?.stop() }
    runCatching { player?.release() }
    player = null
    (getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)?.cancel()
    savedVolume?.let { v -> runCatching { (getSystemService(Context.AUDIO_SERVICE) as AudioManager).setStreamVolume(AudioManager.STREAM_ALARM, v, 0) } }
    runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  companion object {
    const val SOS_CHANNEL = "sos"
    private const val RING_CHANNEL = "sos_ring"
    private const val NOTIFICATION_ID = 4801
    private const val ACTION_STOP = "com.sasvata.veetrax.alarm.STOP"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_ALERT = "alertId"
    /** Long enough to be heard, but a phone nobody is near mustn't ring until its battery dies. */
    private const val MAX_RING_MS = 5 * 60_000L

    fun start(context: Context, title: String, text: String, alertId: String) {
      val intent = Intent(context, AlarmService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text).putExtra(EXTRA_ALERT, alertId)
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, AlarmService::class.java))
    }
  }
}
