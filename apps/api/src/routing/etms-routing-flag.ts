/**
 * Server switch for the ETMS routing and optimisation runtime (doc 17 §7 "Flags": a dedicated `ETMS_ROUTING=on`
 * replaces the routing branch's `ROUTING_ENGINE_V2`). Off by default, and off whenever ETMS itself is off (`ETMS=off`,
 * the same rule as `etmsServerEnabled`).
 *
 * Gated here: usage metering writes and the optimiser client. Not gated: the v1.8 `RoutingService` and the
 * `RoutingProvider` (route estimates, planned-trip paths and live-share ETAs keep working with the switch off), and the
 * pure helpers (coverage check, private-URL check, errors).
 */
export const ETMS_ROUTING_ENV = 'ETMS_ROUTING';

export function etmsRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const etmsOn = (env.ETMS ?? '').trim().toLowerCase() !== 'off';
  return etmsOn && (env[ETMS_ROUTING_ENV] ?? '').trim().toLowerCase() === 'on';
}
