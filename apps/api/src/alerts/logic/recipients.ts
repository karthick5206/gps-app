import { AlertLevel, AlertSeverity, NotifyChannel, RecipientEntry, RecipientMode } from '@veetracer/shared';

export interface RecipientListRow {
  level: AlertLevel;
  targetId: string;
  alertType: string; // type or '*'
  severity: string; // severity or '*'
  channel: NotifyChannel;
  mode: RecipientMode;
  entries: RecipientEntry[];
}

/** The object's hierarchy: targets per level; groups ordered lowest → highest priority. */
export interface RecipientChain {
  companyId: string;
  branchId: string | null;
  groupIdsByPriorityAsc: string[];
  objectId: string;
}

export interface ResolvedEntries {
  mode: RecipientMode;
  /** Level of the row that decided the mode, or null when only default lists applied. */
  decidedBy: { level: AlertLevel; targetId: string; alertType: string; severity: string } | null;
  entries: RecipientEntry[];
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** PUSH recipients when the company has no push list: every user who can see the object. */
export const PUSH_FALLBACK: RecipientEntry = { kind: 'DYNAMIC', value: 'ALL_VIEWERS', label: 'Everyone who can see it' };

/** Indian mobile numbers in E.164: +91 followed by 10 digits. */
export const INDIA_MOBILE_PATTERN = /^\+91\d{10}$/;

export function entryKey(e: RecipientEntry): string {
  const v = e.kind === 'EMAIL' ? e.value.trim().toLowerCase() : e.value.trim();
  return `${e.kind}:${v}`;
}

export function dedupeEntries(entries: RecipientEntry[]): RecipientEntry[] {
  const seen = new Set<string>();
  const out: RecipientEntry[] = [];
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Validates entries; returns an error message or null. USER/ROLE ids are checked against the database by the caller. */
export function validateEntries(entries: RecipientEntry[]): string | null {
  for (const e of entries) {
    switch (e.kind) {
      case 'EMAIL':
        if (!EMAIL_PATTERN.test(e.value.trim())) return `Invalid email "${e.value}"`;
        break;
      case 'MOBILE':
        if (!INDIA_MOBILE_PATTERN.test(e.value.trim())) return `Invalid mobile "${e.value}" — use +91 followed by 10 digits`;
        break;
      case 'DYNAMIC':
        if (e.value !== 'OBJECT_USERS' && e.value !== 'BRANCH_MANAGERS' && e.value !== 'ALL_VIEWERS') return `Unknown dynamic recipient "${e.value}"`;
        break;
      case 'USER':
      case 'ROLE':
        if (!/^[0-9a-f-]{36}$/i.test(e.value)) return `Invalid ${e.kind.toLowerCase()} id "${e.value}"`;
        break;
      default:
        return `Unknown recipient kind "${(e as RecipientEntry).kind}"`;
    }
  }
  return null;
}

/** Ordered levels/targets from least to most specific. */
function levelsAsc(chain: RecipientChain): { level: AlertLevel; targetId: string }[] {
  const out: { level: AlertLevel; targetId: string }[] = [{ level: 'COMPANY', targetId: chain.companyId }];
  if (chain.branchId) out.push({ level: 'BRANCH', targetId: chain.branchId });
  for (const g of chain.groupIdsByPriorityAsc) out.push({ level: 'GROUP', targetId: g });
  out.push({ level: 'OBJECT', targetId: chain.objectId });
  return out;
}

function applyMode(base: RecipientEntry[], mode: RecipientMode, entries: RecipientEntry[], isRoot: boolean): RecipientEntry[] {
  switch (mode) {
    case 'DEFAULT':
      return isRoot ? entries : base;
    case 'ADD':
      return dedupeEntries([...base, ...entries]);
    case 'ONLY':
      return entries;
    case 'NONE':
      return [];
  }
}

/**
 * Recipients of one channel for an object/alert type/severity.
 * 1. Default lists (alertType '*' and severity '*') are folded from COMPANY → BRANCH → GROUPS (low → high priority) → OBJECT:
 *    DEFAULT = inherit (the company row is the base), ADD = parent + entries, ONLY = entries, NONE = nobody.
 * 2. The most specific alert-specific row (OBJECT > GROUP by priority > BRANCH > COMPANY; within a level
 *    type+severity > type+'*' > '*'+severity) then applies its mode to those defaults. No such row = the defaults.
 */
export function resolveRecipientEntries(
  rows: RecipientListRow[],
  chain: RecipientChain,
  alertType: string,
  severity: AlertSeverity,
  channel: NotifyChannel,
): ResolvedEntries {
  const levels = levelsAsc(chain);
  const forChannel = rows.filter((r) => r.channel === channel);
  // Nothing set up for push at any level: phones of everyone who can see the object (an SOS must never go nowhere).
  if (channel === 'PUSH' && !forChannel.length) return { mode: 'DEFAULT', decidedBy: null, entries: [PUSH_FALLBACK] };
  const at = (level: AlertLevel, targetId: string) => forChannel.filter((r) => r.level === level && r.targetId === targetId);

  let defaults: RecipientEntry[] = [];
  for (const [i, l] of levels.entries()) {
    const row = at(l.level, l.targetId).find((r) => r.alertType === '*' && r.severity === '*');
    if (row) defaults = applyMode(defaults, row.mode, row.entries, i === 0);
  }

  const specificity = (r: RecipientListRow): number => {
    if (r.alertType === alertType && r.severity === severity) return 3;
    if (r.alertType === alertType && r.severity === '*') return 2;
    if (r.alertType === '*' && r.severity === severity) return 1;
    return 0;
  };
  for (const l of [...levels].reverse()) {
    const candidates = at(l.level, l.targetId)
      .filter((r) => specificity(r) > 0)
      .sort((a, b) => specificity(b) - specificity(a));
    const row = candidates[0];
    if (!row) continue;
    const entries = row.mode === 'DEFAULT' ? defaults : applyMode(defaults, row.mode, row.entries, false);
    return {
      mode: row.mode,
      decidedBy: { level: row.level, targetId: row.targetId, alertType: row.alertType, severity: row.severity },
      entries: dedupeEntries(entries),
    };
  }
  return { mode: 'DEFAULT', decidedBy: null, entries: dedupeEntries(defaults) };
}
