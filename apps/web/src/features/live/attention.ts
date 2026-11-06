import type { LiveObject } from '@veetracer/shared';

/** Idle longer than this is worth a look (engine on, not moving). */
export const IDLE_ATTENTION_MS = 15 * 60_000;
/** Lost signal within this window: recent enough to act on; older offline vehicles are usually parked or removed. */
export const OFFLINE_ATTENTION_MS = 24 * 60 * 60_000;

export type AttentionKind = 'OVERSPEED' | 'IDLE' | 'OFFLINE';

export interface AttentionItem {
  kind: AttentionKind;
  object: LiveObject;
  /** ms in the current status (0 when unknown). */
  forMs: number;
}

const RANK: Record<AttentionKind, number> = { OVERSPEED: 0, IDLE: 1, OFFLINE: 2 };

/**
 * Vehicles that need someone to look now, most urgent first: overspeeding (fastest first), idling for more than
 * 15 min (longest first), signal lost within the last day (most recent first). Vehicles in maintenance are left out.
 */
export function attentionItems(objects: Iterable<LiveObject>, now: number): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of objects) {
    if (o.inMaintenance) continue;
    const since = o.statusSince ? Date.parse(o.statusSince) : NaN;
    const forMs = Number.isNaN(since) ? 0 : Math.max(0, now - since);
    if (o.status === 'OVERSPEED') out.push({ kind: 'OVERSPEED', object: o, forMs });
    else if (o.status === 'IDLE' && o.type !== 'PERSON' && forMs >= IDLE_ATTENTION_MS) out.push({ kind: 'IDLE', object: o, forMs });
    else if (o.status === 'OFFLINE' && forMs > 0 && forMs <= OFFLINE_ATTENTION_MS) out.push({ kind: 'OFFLINE', object: o, forMs });
  }
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return RANK[a.kind] - RANK[b.kind];
    if (a.kind === 'OVERSPEED') return b.object.speedKph - a.object.speedKph;
    if (a.kind === 'IDLE') return b.forMs - a.forMs;
    return a.forMs - b.forMs;
  });
}
