import { AlertDto, NormalizedPosition, RelayRuleSet, RelayRuleSpec, RelayTargetStats } from '@veetracer/shared';
import { isSuccessStatus } from '../webhooks/retry';
import { signatureHeader } from '../webhooks/signing';
import { alertMatches, passesFilters, RuleIndex } from './rules';
import { TargetStats } from './stats';

export type HttpPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export interface HttpForwarderOptions {
  post: HttpPost;
  /** Items per POST (default 100). */
  batchSize?: number;
  /** Longest wait before a partial batch is sent (default 5 s). */
  flushMs?: number;
  /** Items kept per target while it is failing; oldest dropped beyond (default 10,000). */
  maxQueue?: number;
  /** Delay before retry n (the last value repeats). */
  retryDelaysMs?: readonly number[];
}

type Item = { kind: 'position'; data: Omit<NormalizedPosition, 'raw'> } | { kind: 'alert'; data: AlertDto & { companyId: string } };

/** Body of one POST (documented in docs/RELAY.md). */
export interface RelayBatchBody {
  target: { id: string; name: string };
  sentAt: string;
  positions: Omit<NormalizedPosition, 'raw'>[];
  alerts: (AlertDto & { companyId: string })[];
}

/** Value of the Authorization header for a stored auth type + value. */
export function authorizationHeader(type: string, value: string | null | undefined): string | null {
  if (!value) return null;
  if (type === 'BEARER') return `Bearer ${value}`;
  if (type === 'BASIC') return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
  return null;
}

export function batchHeaders(rule: Pick<RelayRuleSpec, 'id' | 'secret' | 'authorization'>, body: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'VeeTrax-Relay/1.0',
    'X-VeeTrax-Relay-Target': rule.id,
    'X-VeeTrax-Signature': signatureHeader(rule.secret, nowSec, body),
  };
  if (rule.authorization) headers.Authorization = rule.authorization;
  return headers;
}

class TargetQueue {
  private items: Item[] = [];
  private inflight = false;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(
    public rule: RelayRuleSpec,
    readonly stats: TargetStats,
    private readonly opts: Required<HttpForwarderOptions>,
  ) {}

  push(item: Item): void {
    if (this.stopped) return;
    this.items.push(item);
    if (this.items.length > this.opts.maxQueue) {
      this.items.splice(0, this.items.length - this.opts.maxQueue);
      this.stats.dropped++;
    }
    this.stats.queued = this.items.length;
    if (this.inflight || this.attempt > 0) return; // a send or a retry is pending
    if (this.items.length >= this.opts.batchSize) this.flush();
    else this.schedule(this.opts.flushMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  /** Sends one batch; on failure puts it back in front and retries with backoff. */
  flush(): void {
    if (this.inflight || this.stopped || !this.items.length) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.items.splice(0, this.opts.batchSize);
    this.stats.queued = this.items.length;
    this.inflight = true;
    const body: RelayBatchBody = {
      target: { id: this.rule.id, name: this.rule.name },
      sentAt: new Date().toISOString(),
      positions: batch.filter((i) => i.kind === 'position').map((i) => i.data as Omit<NormalizedPosition, 'raw'>),
      alerts: batch.filter((i) => i.kind === 'alert').map((i) => i.data as AlertDto & { companyId: string }),
    };
    const json = JSON.stringify(body);
    const url = this.rule.url!;
    this.opts
      .post(url, json, batchHeaders(this.rule, json))
      .then((res) => {
        if (!isSuccessStatus(res.status)) throw new Error(`HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`);
      })
      .then(
        () => {
          const recovered = this.attempt > 0;
          this.attempt = 0;
          this.stats.frames += batch.length;
          this.stats.bytes += Buffer.byteLength(json);
          this.stats.success();
          return recovered ? ('drain' as const) : ('ok' as const);
        },
        (error: Error) => {
          this.stats.error(error.message);
          // Back in front, oldest dropped if new items filled the queue meanwhile.
          this.items = [...batch, ...this.items];
          if (this.items.length > this.opts.maxQueue) {
            const over = this.items.length - this.opts.maxQueue;
            this.items.splice(0, over);
            this.stats.dropped += over;
          }
          this.stats.queued = this.items.length;
          const delays = this.opts.retryDelaysMs;
          const delay = delays[Math.min(this.attempt, delays.length - 1)];
          this.attempt++;
          this.inflight = false;
          this.schedule(delay);
          return 'retry' as const;
        },
      )
      .then((outcome) => {
        if (outcome === 'retry') return;
        this.inflight = false;
        // A full batch, or a backlog left after an outage, goes out at once.
        if (this.items.length >= this.opts.batchSize || (outcome === 'drain' && this.items.length)) this.flush();
        else if (this.items.length) this.schedule(this.opts.flushMs);
      });
  }
}

/**
 * HTTP_JSON data forwarding: matches positions (and alerts) against the rules and posts them to each target in
 * signed batches. In-memory queues (bounded); a restart loses at most what was queued.
 */
export class HttpForwarder {
  private index = new RuleIndex(null, 'HTTP_JSON');
  private readonly queues = new Map<string, TargetQueue>();
  private readonly opts: Required<HttpForwarderOptions>;

  constructor(opts: HttpForwarderOptions) {
    this.opts = { batchSize: 100, flushMs: 5000, maxQueue: 10_000, retryDelaysMs: [1000, 2000, 5000, 15_000, 30_000, 60_000], ...opts };
  }

  get size(): number {
    return this.index.size;
  }

  setRules(set: RelayRuleSet | null): void {
    this.index = new RuleIndex(set, 'HTTP_JSON');
    const ids = new Set<string>();
    for (const r of this.index.rules) {
      if (!r.url) continue;
      ids.add(r.id);
      const q = this.queues.get(r.id);
      if (q) {
        q.rule = r;
        q.stats.name = r.name;
      } else this.queues.set(r.id, new TargetQueue(r, new TargetStats(r.id, r.name, 'HTTP_JSON'), this.opts));
    }
    for (const [id, q] of this.queues) {
      if (ids.has(id)) continue;
      q.stop();
      this.queues.delete(id);
    }
  }

  addPosition(p: NormalizedPosition): void {
    if (!this.queues.size) return;
    for (const r of this.index.forDevice(p.protocol, p.uniqueId)) {
      if (!passesFilters(r, p)) continue;
      const { raw: _raw, ...data } = p;
      this.queues.get(r.id)?.push({ kind: 'position', data });
    }
  }

  addAlert(companyId: string, alert: AlertDto): void {
    for (const r of this.index.rules) {
      if (alertMatches(r, { companyId, objectId: alert.objectId })) this.queues.get(r.id)?.push({ kind: 'alert', data: { ...alert, companyId } });
    }
  }

  /** Sends every partial batch now (tests, shutdown). */
  flushAll(): void {
    for (const q of this.queues.values()) q.flush();
  }

  snapshot(): RelayTargetStats[] {
    return [...this.queues.values()].map((q) => q.stats.snapshot());
  }

  stop(): void {
    for (const q of this.queues.values()) q.stop();
  }
}
