import { BASEMAP_TYPES, type BasemapType, type MapsConfigDto } from '@veetracer/shared';
import { api } from '@/lib/api';

const STORAGE_KEY = 'vt.basemap';

function readStored(): BasemapType {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (BASEMAP_TYPES as readonly string[]).includes(v ?? '') ? (v as BasemapType) : 'standard';
  } catch {
    return 'standard';
  }
}

/**
 * The map type chosen in the switcher (Standard / Light / Satellite), remembered per browser, and the server's
 * satellite imagery settings (`GET /maps/config`, loaded once). Maps re-style when either changes.
 */
class BasemapStore {
  private value: BasemapType = readStored();
  private config: MapsConfigDto | null = null;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  get type(): BasemapType {
    return this.value;
  }

  /** Satellite tiles, or null when not configured or not loaded yet. */
  get satellite(): MapsConfigDto['satellite'] {
    return this.config?.satellite ?? null;
  }

  get satelliteAvailable(): boolean {
    return !!this.config?.satellite;
  }

  set(type: BasemapType) {
    if (type === this.value) return;
    this.value = type;
    try {
      localStorage.setItem(STORAGE_KEY, type);
    } catch {
      // private mode: the choice lasts for this page only
    }
    this.emit();
  }

  /** Loads the server's basemap settings once; a satellite choice takes effect when they arrive. */
  ensureConfig(): void {
    if (this.config || this.loading) return;
    this.loading = api
      .get<MapsConfigDto>('/maps/config')
      .then((c) => {
        this.config = c;
        // Listeners: the switcher (Satellite becomes available) and the maps (they re-style only if their style changed).
        this.emit();
      })
      .catch(() => {
        this.loading = null;
      });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export const basemapStore = new BasemapStore();
