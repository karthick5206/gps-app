import { NormalizedPosition, RelayRuleSet, RelayRuleSpec } from '@veetracer/shared';

/**
 * Pure matching of data forwarding rules (shared by the gateway's RAW_TCP relay and the notifier's HTTP_JSON forwarder).
 * Rules arrive resolved: COMPANY / DEVICES scopes carry the device unique ids, so no database is needed to match.
 */

/** Whether a device connection / position of `protocol` + `uniqueId` falls in the rule's scope. */
export function inScope(rule: Pick<RelayRuleSpec, 'scope' | 'protocol' | 'uniqueIds'>, protocol: string, uniqueId: string): boolean {
  switch (rule.scope) {
    case 'ALL':
      return true;
    case 'PROTOCOL':
      return !!rule.protocol && rule.protocol === protocol;
    case 'COMPANY':
    case 'DEVICES':
      return !!rule.uniqueIds && rule.uniqueIds.includes(uniqueId);
    default:
      return false;
  }
}

/** Per-rule filters on one position: live only (no history / re-upload), valid fixes only. */
export function passesFilters(rule: Pick<RelayRuleSpec, 'liveOnly' | 'validOnly'>, p: Pick<NormalizedPosition, 'valid' | 'attributes'>): boolean {
  if (rule.validOnly && !p.valid) return false;
  if (rule.liveOnly && p.attributes?.reupload === true) return false;
  return true;
}

export function positionMatches(rule: RelayRuleSpec, p: NormalizedPosition): boolean {
  return inScope(rule, p.protocol, p.uniqueId) && passesFilters(rule, p);
}

/** Alerts carry company and object (no device): ALL, COMPANY and DEVICES (by assigned object) scopes match. */
export function alertMatches(rule: RelayRuleSpec, alert: { companyId: string; objectId: string }): boolean {
  if (!rule.includeAlerts) return false;
  switch (rule.scope) {
    case 'ALL':
      return true;
    case 'COMPANY':
      return rule.companyId === alert.companyId;
    case 'DEVICES':
      return !!rule.objectIds?.includes(alert.objectId);
    default:
      return false;
  }
}

/** Indexed view of a rule set for one target type, so per-position matching stays O(rules). */
export class RuleIndex {
  readonly rules: RelayRuleSpec[];
  private readonly ids = new Map<string, Set<string>>();

  constructor(set: RelayRuleSet | null, type: RelayRuleSpec['type']) {
    this.rules = (set?.rules ?? []).filter((r) => r.type === type);
    for (const r of this.rules) if (r.uniqueIds) this.ids.set(r.id, new Set(r.uniqueIds));
  }

  get size(): number {
    return this.rules.length;
  }

  /** Rules whose scope covers this device (filters not applied). */
  forDevice(protocol: string, uniqueId: string): RelayRuleSpec[] {
    return this.rules.filter((r) => {
      const ids = this.ids.get(r.id);
      if (ids) return ids.has(uniqueId);
      return inScope(r, protocol, uniqueId);
    });
  }
}

/** Parses the Valkey value; null on garbage. */
export function parseRuleSet(raw: string | null): RelayRuleSet | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as RelayRuleSet;
    return Array.isArray(v?.rules) ? v : null;
  } catch {
    return null;
  }
}
