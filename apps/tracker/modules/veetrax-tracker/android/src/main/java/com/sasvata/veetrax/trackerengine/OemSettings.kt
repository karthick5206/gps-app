package com.sasvata.veetrax.trackerengine

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Opens the phone maker's "autostart" / "background activity" screen, where OEM battery managers (MIUI, ColorOS,
 * Funtouch / OriginOS, OxygenOS, One UI, EMUI) let the user allow the app to run in the background.
 * These activities are undocumented and change between OS versions, so we just try the known ones for this
 * manufacturer and fall back to the app's system "App info" page.
 *
 * startActivity() is used directly (no resolveActivity()): Android 11 package visibility would hide the OEM
 * packages from resolveActivity() unless declared in <queries>, but launching an explicit, exported activity works.
 */
object OemSettings {

  private fun c(pkg: String, cls: String) = ComponentName(pkg, cls)

  private val xiaomi = listOf(
    c("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
    c("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
  )
  private val oppo = listOf( // also Realme and newer OnePlus (ColorOS)
    c("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
    c("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
    c("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
    c("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
  )
  private val vivo = listOf(
    c("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
    c("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
    c("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
  )
  private val oneplus = listOf(
    c("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
  )
  private val samsung = listOf( // Device care → Battery → Background usage limits ("Never sleeping apps")
    c("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
    c("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
    c("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"),
  )
  private val huawei = listOf(
    c("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
    c("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
  )
  private val asus = listOf(
    c("com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity"),
  )

  fun candidates(): List<ComponentName> = when (Build.MANUFACTURER.lowercase()) {
    "xiaomi", "redmi", "poco" -> xiaomi
    "oppo", "realme" -> oppo
    "oneplus" -> oneplus + oppo
    "vivo", "iqoo" -> vivo
    "samsung" -> samsung
    "huawei", "honor" -> huawei
    "asus" -> asus
    else -> emptyList()
  }

  /** Returns "oem" when a maker-specific screen opened, "app_details" for the fallback, "none" if nothing did. */
  fun open(context: Context, activity: Activity?): String {
    val starter: Context = activity ?: context
    fun tryStart(i: Intent): Boolean = try {
      if (activity == null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      starter.startActivity(i)
      true
    } catch (_: Exception) { // ActivityNotFoundException, SecurityException (not exported)
      false
    }
    for (cn in candidates()) {
      if (tryStart(Intent().setComponent(cn))) return "oem"
    }
    val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
    return if (tryStart(details)) "app_details" else "none"
  }
}
