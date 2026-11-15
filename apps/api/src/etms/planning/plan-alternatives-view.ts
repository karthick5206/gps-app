import { isRoutingStrategy, type RoutePlanDetailDto } from '@veetracer/shared';
import { storedPreferencesOf } from '../../routing-jobs/strategies';

/** E4 WP-A detail fields from RoutePlan.options: strategy (only when it gave the weights), preferences, alternativeOf. */
export function runView(options: unknown): Pick<RoutePlanDetailDto, 'strategy' | 'preferences' | 'alternativeOf'> {
  const o = (options && typeof options === 'object' && !Array.isArray(options) ? options : {}) as Record<string, unknown>;
  return {
    strategy: isRoutingStrategy(o.strategy) && o.weightsSource !== 'weights' ? o.strategy : null,
    preferences: storedPreferencesOf(o) ?? null,
    alternativeOf: typeof o.alternativeOf === 'string' ? o.alternativeOf : null,
  };
}
