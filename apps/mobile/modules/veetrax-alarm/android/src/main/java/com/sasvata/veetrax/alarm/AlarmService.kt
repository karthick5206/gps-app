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
 *
 * Without the full-screen permission (Android 14+ grants it only to alarm-clock and calling apps unless the user
 * allows it), Android shows the notification as a banner for a short time instead. Then the screen is woken, the
 * banner is posted again every REPOST_MS while it rings (it can't be swiped away), and opening the app goes straight
 * to the SOS screen (ringingAlertId); the siren itself never depends on the permission.
 */
class AlarmService : Service() {
  private var player: MediaPlayer? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var savedVolume: Int? = null
  private val handler = Handler(Looper.getMainLooper())
  private val stopLater = Runnable { stopSelf() }
  private var lastNotification: Notification? = null
  private var screenLock: PowerManager.WakeLock? = null
  /** Re-posts the banner so it keeps coming back while the alarm rings (no full-screen permission). */
  private val repost = object : Runnable {
    override fun run() {
      val n = lastNotification ?: return
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, n)
      handler.postDelayed(this, REPOST_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val alertId = intent?.getStringExtra(EXTRA_ALERT).orEmpty()
    ringingAlert = alertId.ifEmpty { "unknown" }
    val notification = buildNotification(intent?.getStringExtra(EXTRA_TITLE).orEmpty(), intent?.getStringExtra(EXTRA_TEXT).orEmpty(), alertId)
    lastNotification = notification
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    ring()
    if (!canFullScreen(this)) {
      wakeScreen()
      handler.removeCallbacks(repost)
      handler.postDelayed(repost, REPOST_MS)
    }
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

  /** Turns the screen on so the SOS banner is seen on the lock screen (old API, still honoured for this). */
  @Suppress("DEPRECATION")
  private fun wakeScreen() {
    if (screenLock != null) return
    screenLock = runCatching {
      (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE, "veetrax:alarm-screen")
        .apply { acquire(30_000) }
    }.getOrNull()
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
      .addAction(0, getString(R.string.veetrax_alarm_open), content)
      // Each re-post must pop up again as a banner.
      .setOnlyAlertOnce(false)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  override fun onDestroy() {
    handler.removeCallbacks(stopLater)
    handler.removeCallbacks(repost)
    ringingAlert = null
    lastNotification = null
    runCatching { if (screenLock?.isHeld == true) screenLock?.release() }
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
    /** Banner re-post interval without the full-screen permission (Android hides a banner after a few seconds). */
    private const val REPOST_MS = 20_000L

    /** Alert id of the alarm ringing now (null when silent): the app opens its SOS screen when brought forward. */
    @Volatile var ringingAlert: String? = null

    /** Whether Android lets this app show the SOS screen over the lock screen (always true before Android 14). */
    fun canFullScreen(context: Context): Boolean =
      Build.VERSION.SDK_INT < 34 || (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).canUseFullScreenIntent()

    fun start(context: Context, title: String, text: String, alertId: String) {
      val intent = Intent(context, AlarmService::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text).putExtra(EXTRA_ALERT, alertId)
      ContextCompat.startForegroundService(context, intent)
    }

    private const val INSISTENT_CHANNEL = "sos_insistent"
    private const val INSISTENT_ID = 4802

    /** The bundled siren (also used by the 'sos' push channel), else the phone's alarm sound. */
    fun sirenUri(context: Context): Uri {
      val id = context.resources.getIdentifier("sos_siren", "raw", context.packageName)
      return if (id != 0) Uri.parse("android.resource://${context.packageName}/$id") else RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
    }

    /**
     * Backup when the alarm service can't start: a notification on an alarm-volume channel with the siren, flagged
     * insistent so Android repeats the sound until it is opened or dismissed.
     */
    fun postInsistent(context: Context, title: String, text: String, alertId: String) {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(INSISTENT_CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(INSISTENT_CHANNEL, context.getString(R.string.veetrax_alarm_channel), NotificationManager.IMPORTANCE_HIGH).apply {
          setSound(sirenUri(context), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          setBypassDnd(true)
        })
      }
      val open = Intent(Intent.ACTION_VIEW, Uri.parse("veetrax:///sos/${if (alertId.isEmpty()) "unknown" else alertId}${if (alertId == "test") "?test=1" else ""}")).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
      val content = PendingIntent.getActivity(context, 5, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val n = NotificationCompat.Builder(context, INSISTENT_CHANNEL)
        .setSmallIcon(context.applicationInfo.icon)
        .setColor(0xFFC62828.toInt())
        .setContentTitle(title.ifEmpty { context.getString(R.string.veetrax_alarm_channel) })
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setContentIntent(content)
        .setFullScreenIntent(content, true)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .build()
      n.flags = n.flags or Notification.FLAG_INSISTENT
      nm.notify(INSISTENT_ID, n)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, AlarmService::class.java))
    }
  }
}
