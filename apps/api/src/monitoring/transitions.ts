import { HealthEvent, HealthIssue } from '@veetracer/shared';
import { Issue } from './checks';

/** Per check: when the last alert e-mail went out and whether a recovery e-mail is still owed. */
export interface AlertRecord {
  alertAt: number;
  notified: boolean;
}

export interface TransitionResult {
  /** Issues active after this evaluation (with since-times carried over). */
  active: HealthIssue[];
  events: HealthEvent[];
  /** New or escalated issues to e-mail now (cooldown applied). */
  alert: HealthIssue[];
  /** Resolved issues whose alert was e-mailed: send a recovery. */
  recovered: HealthIssue[];
  /** Updated alert records (only changed ones). */
  records: Map<string, AlertRecord>;
}

/**
 * Compares the previous active issues with the current check results. A check that stays in the same severity keeps
 * its since-time; a new or escalated (WARN → CRITICAL) one is e-mailed unless the same check alerted within the
 * cooldown (escalations always go out); a resolved one gets a recovery e-mail if its alert was sent.
 */
export function diffIssues(
  previous: HealthIssue[],
  current: Issue[],
  records: Map<string, AlertRecord>,
  now: number,
  cooldownMs: number,
): TransitionResult {
  const at = new Date(now).toISOString();
  const prev = new Map(previous.map((i) => [i.id, i]));
  const active: HealthIssue[] = [];
  const events: HealthEvent[] = [];
  const alert: HealthIssue[] = [];
  const recovered: HealthIssue[] = [];
  const changed = new Map<string, AlertRecord>();

  for (const issue of current) {
    const before = prev.get(issue.id);
    if (before && before.severity === issue.severity) {
      active.push({ ...issue, since: before.since });
      continue;
    }
    const next: HealthIssue = { ...issue, since: at };
    active.push(next);
    events.push({ at, id: issue.id, check: issue.check, from: before?.severity ?? 'OK', to: issue.severity, message: issue.message });
    const escalated = before?.severity === 'WARN' && issue.severity === 'CRITICAL';
    if (before && !escalated) continue; // downgrade CRITICAL → WARN: event only
    const record = records.get(issue.id);
    if (escalated || !record || now - record.alertAt >= cooldownMs) {
      alert.push(next);
      changed.set(issue.id, { alertAt: now, notified: true });
    }
  }

  const currentIds = new Set(current.map((i) => i.id));
  for (const before of previous) {
    if (currentIds.has(before.id)) continue;
    events.push({ at, id: before.id, check: before.check, from: before.severity, to: 'OK', message: `Recovered: ${before.message}` });
    const record = records.get(before.id);
    if (record?.notified) {
      recovered.push(before);
      changed.set(before.id, { ...record, notified: false });
    }
  }
  return { active, events, alert, recovered, records: changed };
}
