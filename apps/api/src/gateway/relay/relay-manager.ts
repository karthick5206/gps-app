import { Logger } from '@nestjs/common';
import { RELAY_PASS_DOWNSTREAM_PROTOCOLS, RelayRuleSet, RelayRuleSpec, RelayTargetStats } from '@veetracer/shared';
import { checkAddresses, RelayPolicy } from '../../relay/guard';
import { RuleIndex } from '../../relay/rules';
import { TargetStats } from '../../relay/stats';
import { RelayUpstream, UpstreamOptions } from './upstream';

/** Pre-identification bytes kept per connection (login / registration / auth frames). */
const PRELUDE_MAX_BYTES = 16 * 1024;

export interface RelayLimits {
  maxSocketsPerTarget: number;
  bufferBytes: number;
  bufferFrames: number;
}

export interface RelayManagerOptions {
  policy: RelayPolicy;
  limits: RelayLimits;
  /** Upstream tuning (tests use short backoffs). */
  upstream?: Pick<UpstreamOptions, 'minBackoffMs' | 'maxBackoffMs' | 'connectTimeoutMs' | 'keepAliveMs'>;
  /** Interface addresses of this host (loop guard); defaults to the real ones. */
  localAddresses?: Set<string>;
}

/** What TcpGatewayServer sees of the relay for one device connection. */
export interface RelaySessionHandle {
  /** A chunk exactly as received from the device, with the device's id once known. */
  data(chunk: Buffer, uniqueId: string | null): void;
  close(): void;
}

export interface RelayHook {
  open(protocol: string, toDevice: (data: Buffer) => void): RelaySessionHandle;
}

const signature = (r: RelayRuleSpec) => `${r.host}:${r.port}:${r.passDownstream ? 1 : 0}`;

/**
 * RAW_TCP data forwarding inside the gateway: one upstream connection per (device connection, matching target),
 * opened once the device identified itself; bytes received before that are replayed first. Rule changes apply to
 * open connections too (upstreams opened / closed as targets appear, change or go away).
 */
export class RelayManager implements RelayHook {
  private readonly logger = new Logger('Relay');
  private index = new RuleIndex(null, 'RAW_TCP');
  private readonly stats = new Map<string, TargetStats>();
  private readonly sessions = new Set<RelaySession>();

  constructor(readonly options: RelayManagerOptions) {}

  get ruleCount(): number {
    return this.index.size;
  }

  setRules(set: RelayRuleSet | null): void {
    this.index = new RuleIndex(set, 'RAW_TCP');
    const ids = new Set(this.index.rules.map((r) => r.id));
    for (const r of this.index.rules) {
      const s = this.stats.get(r.id);
      if (s) s.name = r.name;
      else this.stats.set(r.id, new TargetStats(r.id, r.name, 'RAW_TCP'));
    }
    for (const session of this.sessions) session.reconcile();
    for (const id of [...this.stats.keys()]) if (!ids.has(id)) this.stats.delete(id);
  }

  open(protocol: string, toDevice: (data: Buffer) => void): RelaySessionHandle {
    const session = new RelaySession(this, protocol, toDevice);
    this.sessions.add(session);
    return session;
  }

  /** Per-target counters for the heartbeat. */
  snapshot(): RelayTargetStats[] {
    return [...this.stats.values()].map((s) => s.snapshot());
  }

  closeAll(): void {
    for (const s of [...this.sessions]) s.close();
  }

  /** @internal */
  forget(session: RelaySession): void {
    this.sessions.delete(session);
  }

  /** @internal */
  rulesFor(protocol: string, uniqueId: string): RelayRuleSpec[] {
    return this.index.forDevice(protocol, uniqueId).filter((r) => r.host && r.port);
  }

  /** @internal Opens an upstream, or null when the target's socket limit is reached. */
  connect(rule: RelayRuleSpec, protocol: string, prelude: () => Buffer[], toDevice: (data: Buffer) => void): RelayUpstream | null {
    const stats = this.stats.get(rule.id);
    if (!stats) return null;
    const { limits, policy } = this.options;
    if (stats.sessions >= limits.maxSocketsPerTarget) {
      stats.dropped++;
      stats.error(`Upstream socket limit (${limits.maxSocketsPerTarget}) reached; device not forwarded`);
      return null;
    }
    const passDown = rule.passDownstream && RELAY_PASS_DOWNSTREAM_PROTOCOLS.includes(protocol);
    return new RelayUpstream({
      host: rule.host!,
      port: rule.port!,
      prelude,
      stats,
      maxBytes: limits.bufferBytes,
      maxFrames: limits.bufferFrames,
      onDownstream: passDown ? toDevice : null,
      checkAddresses: (addresses, port) => checkAddresses(addresses, port, policy, this.options.localAddresses),
      ...this.options.upstream,
    });
  }

  /** @internal */
  warn(message: string): void {
    this.logger.warn(message);
  }
}

class RelaySession implements RelaySessionHandle {
  private uniqueId: string | null = null;
  private readonly prelude: Buffer[] = [];
  private preludeBytes = 0;
  private readonly upstreams = new Map<string, { sig: string; up: RelayUpstream }>();
  private closed = false;

  constructor(
    private readonly manager: RelayManager,
    private readonly protocol: string,
    private readonly toDevice: (data: Buffer) => void,
  ) {}

  data(chunk: Buffer, uniqueId: string | null): void {
    if (this.closed) return;
    if (!this.uniqueId) {
      // Keep everything up to (and including) the chunk that identified the device; replayed on every connect.
      if (this.preludeBytes + chunk.length <= PRELUDE_MAX_BYTES) {
        this.prelude.push(Buffer.from(chunk));
        this.preludeBytes += chunk.length;
      }
      if (!uniqueId) return;
      this.uniqueId = uniqueId;
      this.reconcile();
      return;
    }
    for (const { up } of this.upstreams.values()) up.write(chunk);
  }

  /** Opens / closes upstreams to match the current rules. */
  reconcile(): void {
    if (this.closed || !this.uniqueId) return;
    const rules = this.manager.rulesFor(this.protocol, this.uniqueId);
    const wanted = new Map(rules.map((r) => [r.id, r]));
    for (const [id, entry] of this.upstreams) {
      const r = wanted.get(id);
      if (!r || signature(r) !== entry.sig) {
        entry.up.close();
        this.upstreams.delete(id);
      }
    }
    for (const r of rules) {
      if (this.upstreams.has(r.id)) continue;
      const up = this.manager.connect(r, this.protocol, () => this.prelude, this.toDevice);
      if (up) this.upstreams.set(r.id, { sig: signature(r), up });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { up } of this.upstreams.values()) up.close();
    this.upstreams.clear();
    this.prelude.length = 0;
    this.manager.forget(this);
  }
}
