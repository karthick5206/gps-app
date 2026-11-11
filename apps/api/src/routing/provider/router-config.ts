/**
 * Road-engine configuration for the routing provider. One engine config for the whole API (doc 17 §4.1 E-3):
 * `ROUTER_URL` (GraphHopper base URL, production http://127.0.0.1:8989) + `ROUTER_ENGINE=graphhopper`.
 *
 * `RoutingService` (v1.8) treats an unset `ROUTER_ENGINE` as `valhalla`, so the same `ROUTER_URL` could be read as two
 * different engines. The provider removes that ambiguity: it works only when `ROUTER_ENGINE` is explicitly
 * `graphhopper`, and refuses anything else with a clear message instead of sending GraphHopper requests to an engine
 * of unknown type.
 */

export const SUPPORTED_ENGINE = 'graphhopper';

export type RouterConfig =
  | { state: 'disabled'; message: string }
  | { state: 'refused'; engine: string; message: string }
  | { state: 'graphhopper'; baseUrl: string };

export class RoutingEngineConfigError extends Error {
  readonly code = 'ROUTER_ENGINE_NOT_SUPPORTED';
  constructor(
    message: string,
    readonly engine: string,
  ) {
    super(message);
    this.name = 'RoutingEngineConfigError';
  }
}

export function readRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const baseUrl = (env.ROUTER_URL ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { state: 'disabled', message: 'Routing engine disabled: ROUTER_URL is not set.' };
  const engine = (env.ROUTER_ENGINE ?? '').trim().toLowerCase();
  if (engine === SUPPORTED_ENGINE) return { state: 'graphhopper', baseUrl };
  const message = engine
    ? `ROUTER_ENGINE=${engine} is not supported by the routing provider: GraphHopper is the only road engine (ETMS D3). ` +
      'Set ROUTER_ENGINE=graphhopper and point ROUTER_URL at GraphHopper.'
    : 'ROUTER_ENGINE is not set (RoutingService reads that as valhalla). The routing provider supports only ' +
      'ROUTER_ENGINE=graphhopper; set it explicitly with ROUTER_URL pointing at GraphHopper.';
  return { state: 'refused', engine: engine || '(unset)', message };
}

/** For callers that must not start without GraphHopper (e.g. a future routing worker): throws instead of degrading. */
export function requireGraphHopper(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = readRouterConfig(env);
  if (cfg.state === 'graphhopper') return cfg.baseUrl;
  throw new RoutingEngineConfigError(cfg.message, cfg.state === 'refused' ? cfg.engine : '(disabled)');
}
