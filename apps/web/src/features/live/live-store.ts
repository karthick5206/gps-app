import type { LiveObject } from '@veetracer/shared';
import { api } from '@/lib/api';

export type LiveEvent = { type: 'snapshot' } | { type: 'reset' } | { type: 'batch'; changed: LiveObject[] };
type Listener = (event: LiveEvent) => void;

/**
 * Live object state outside React. The map consumes events imperatively; React views read
 * through throttled hooks so a 10k-object fleet never re-renders on every socket message.
 */
class LiveStore {
  private objects = new Map<string, LiveObject>();
  private listeners = new Set<Listener>();
  private list: LiveObject[] | null = null;
  private snapshotPromise: Promise<void> | null = null;
  private loaded = false;
  private version = 0;

  get snapshotLoaded() {
    return this.loaded;
  }

  getVersion() {
    return this.version;
  }

  get(id: string): LiveObject | undefined {
    return this.objects.get(id);
  }

  /** All objects (cached until the next change). */
  all(): LiveObject[] {
    if (!this.list) this.list = Array.from(this.objects.values());
    return this.list;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: LiveEvent) {
    this.version++;
    this.list = null;
    this.listeners.forEach((l) => l(event));
  }

  /** Loads (or reloads) the snapshot from GET /api/live. Concurrent calls share one request. */
  loadSnapshot(): Promise<void> {
    if (this.snapshotPromise) return this.snapshotPromise;
    this.snapshotPromise = api
      .get<LiveObject[]>('/live')
      .then((items) => {
        this.objects = new Map(items.map((o) => [o.objectId, o]));
        this.loaded = true;
        this.emit({ type: 'snapshot' });
      })
      .finally(() => {
        this.snapshotPromise = null;
      });
    return this.snapshotPromise;
  }

  /** Merges a `live:batch` (latest state per object). */
  applyBatch(items: LiveObject[]) {
    if (!items.length) return;
    // Socket states carry no photo version (it comes with the snapshot): keep the one we have.
    const merged = items.map((o) => {
      const prev = this.objects.get(o.objectId);
      return o.photoVersion === undefined && prev?.photoVersion !== undefined ? { ...o, photoVersion: prev.photoVersion } : o;
    });
    for (const o of merged) this.objects.set(o.objectId, o);
    this.emit({ type: 'batch', changed: merged });
  }

  /** Local change of one object (e.g. a new person photo) shown at once. */
  patch(objectId: string, changes: Partial<LiveObject>) {
    const prev = this.objects.get(objectId);
    if (!prev) return;
    const next = { ...prev, ...changes };
    this.objects.set(objectId, next);
    this.emit({ type: 'batch', changed: [next] });
  }

  reset() {
    this.objects.clear();
    this.loaded = false;
    this.emit({ type: 'reset' });
  }
}

export const liveStore = new LiveStore();
