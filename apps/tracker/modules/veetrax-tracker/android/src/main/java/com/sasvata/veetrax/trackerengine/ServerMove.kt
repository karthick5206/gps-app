package com.sasvata.veetrax.trackerengine

import java.net.URI

/**
 * Moving the phone to another server address (app 1.5.0+). The server names the address phones should use
 * (`server.url` in /me and upload answers, set by TRACKER_SERVER_URL); the engine switches only when
 *  - the address is plain https on a domain built into the app (a wrong or hijacked setting can't send phones
 *    to someone else's server; same list as the API's TRACKER_SERVER_DOMAINS), and
 *  - the phone's own login works there (GET /api/tracker/v1/me answers 2xx), so the data must have moved first.
 * A refused move is tried again at most once per RETRY_MS for the same address. Pure logic, no Android types.
 */
object ServerMove {
  val ALLOWED_DOMAINS = listOf("veetrax.com", "mintplus.co.in")
  const val RETRY_MS = 60 * 60_000L

  /** "https://host" for an acceptable address, else null. */
  fun normalize(raw: String?): String? {
    val value = raw?.trim()?.trimEnd('/') ?: return null
    if (value.isEmpty()) return null
    val uri = try { URI(value) } catch (_: Exception) { return null }
    if (!"https".equals(uri.scheme, ignoreCase = true)) return null
    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
    if (uri.port != -1 && uri.port != 443) return null
    if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
    val host = uri.host?.lowercase() ?: return null
    if (ALLOWED_DOMAINS.none { host == it || host.endsWith(".$it") }) return null
    return "https://$host"
  }

  /**
   * The address to try now, or null: unusable, already in use, or the same address was refused less than
   * RETRY_MS ago.
   */
  fun target(offered: String?, current: String, lastTarget: String?, lastTriedAt: Long, now: Long): String? {
    val next = normalize(offered) ?: return null
    if (next.equals(current.trimEnd('/'), ignoreCase = true)) return null
    if (next == lastTarget && now - lastTriedAt in 0 until RETRY_MS) return null
    return next
  }
}
