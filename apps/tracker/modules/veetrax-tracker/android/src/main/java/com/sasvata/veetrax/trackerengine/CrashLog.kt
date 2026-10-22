package com.sasvata.veetrax.trackerengine

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Remembers the last crash of this app (any thread, native side) so the app can show it and send it to the server
 * on the next start: we usually can't attach a phone to read logcat. The previous handler still runs, so Android
 * shows / logs the crash as usual.
 */
object CrashLog {
  private const val FILE = "veetrax_crash"
  private const val KEY = "last"
  @Volatile private var installed = false

  fun install(context: Context) {
    if (installed) return
    synchronized(this) {
      if (installed) return
      installed = true
      val app = context.applicationContext
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, e ->
        try {
          val sw = StringWriter()
          e.printStackTrace(PrintWriter(sw))
          val text = "native crash on ${thread.name} at ${System.currentTimeMillis()} · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})\n$sw"
          // commit(), not apply(): the process is about to die.
          app.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, text.take(8000)).commit()
        } catch (_: Throwable) {
        }
        Log.e("VeeTraxTracker", "crash", e)
        previous?.uncaughtException(thread, e)
      }
    }
  }

  /** The last crash report (and forget it), or null. */
  fun take(context: Context): String? {
    val sp = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    val text = sp.getString(KEY, null)
    if (text != null) sp.edit().remove(KEY).apply()
    return text
  }
}
