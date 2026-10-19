import { ProcessHeartbeat, RELAY_FAILING_WARN_SEC, RelayTargetStats, RelayTargetType } from '@veetracer/shared';

const RECENT_ERRORS = 10;

/** Mutable counters of one target in one process (reported in the process heartbeat). */
export class TargetStats {
  connected = 0;
  sessions = 0;
  bytes = 0;
  frames = 0;
  queued = 0;
  dropped = 0;
  lastSuccessAt: number | null = null;
  lastError: { message: string; at: number } | null = null;
  failingSince: number | null = null;
  readonly recentErrors: { message: string; at: number }[] = [];

  constructor(
    readonly id: string,
    public name: string,
    readonly type: RelayTargetType,
  ) {}

  success(now = Date.now()): void {
    this.lastSuccessAt = now;
    this.failingSince = null;
  }

  error(message: string, now = Date.now()): void {
    this.lastError = { message, at: now };
    this.failingSince ??= now;
    const last = this.recentErrors[0];
    // Collapse repeats (reconnect loops) so the list shows distinct problems.
    if (last && last.message === message) last.at = now;
    else {
      this.recentErrors.unshift({ message, at: now });
      if (this.recentErrors.length > RECENT_ERRORS) this.recentErrors.pop();
    }
  }

  snapshot(): RelayTargetStats {
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      connected: this.connected,
      sessions: this.sessions,
      bytes: this.bytes,
      frames: this.frames,
      queued: this.queued,
      dropped: this.dropped,
      lastSuccessAt: iso(this.lastSuccessAt),
      lastError: this.lastError ? { message: this.lastError.message, at: iso(this.lastError.at)! } : null,
      failingSince: iso(this.failingSince),
      recentErrors: this.recentErrors.map((e) => ({ message: e.message, at: iso(e.at)! })),
    };
  }
}

const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Sums the stats of one target reported by several processes (gateway / notifier instances). */
export function mergeStats(list: RelayTargetStats[]): RelayTargetStats | null {
  if (!list.length) return null;
  const [first, ...rest] = list;
  const out: RelayTargetStats = { ...first, recentErrors: [...first.recentErrors] };
  for (const s of rest) {
    out.connected += s.connected;
    out.sessions += s.sessions;
    out.bytes += s.bytes;
    out.frames += s.frames;
    out.queued += s.queued;
    out.dropped += s.dropped;
    out.lastSuccessAt = maxIso(out.lastSuccessAt, s.lastSuccessAt);
    if (s.lastError && (!out.lastError || s.lastError.at > out.lastError.at)) out.lastError = s.lastError;
    // Failing only while every instance is failing; the streak starts at the latest instance's start.
    out.failingSince = out.failingSince && s.failingSince ? maxIso(out.failingSince, s.failingSince) : null;
    out.recentErrors.push(...s.recentErrors);
  }
  out.recentErrors.sort((a, b) => (a.at < b.at ? 1 : -1));
  out.recentErrors.splice(RECENT_ERRORS);
  return out;
}

/** True when the target has been failing for longer than the System Health threshold. */
export function isFailing(s: RelayTargetStats | null, now = Date.now(), thresholdSec = RELAY_FAILING_WARN_SEC): boolean {
  return !!s?.failingSince && now - Date.parse(s.failingSince) > thresholdSec * 1000;
}

/** Per-target relay stats from the gateway / notifier heartbeats, merged over instances. */
export function relayStatsFromHeartbeats(heartbeats: Pick<ProcessHeartbeat, 'role' | 'metrics'>[]): Map<string, RelayTargetStats> {
  const byId = new Map<string, RelayTargetStats[]>();
  for (const h of heartbeats) {
    if (h.role !== 'gateway' && h.role !== 'notifier') continue;
    for (const s of (h.metrics as { relay?: RelayTargetStats[] })?.relay ?? []) {
      const list = byId.get(s.id) ?? [];
      list.push(s);
      byId.set(s.id, list);
    }
  }
  const out = new Map<string, RelayTargetStats>();
  for (const [id, list] of byId) out.set(id, mergeStats(list)!);
  return out;
}
