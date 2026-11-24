import { useSyncExternalStore } from 'react';

/** The vehicle shown in the floating live player (picture-in-picture), or null when it is closed. */
export interface FloatingVideo {
  objectId: string;
  vehicle: string;
  /** Channels the camera has (1 = road, 2 = driver for Jimi); `selected` are the ones playing. */
  channels: number[];
  selected: number[];
}

type Listener = () => void;

/**
 * One floating live player for the whole app: opened from a vehicle's Video tab ("Pop out") or an alert ("Go live"),
 * it stays on screen while the user moves around the map and other pages. A plain external store read through
 * useSyncExternalStore (never cached in component state, so the React Compiler cannot serve a stale value).
 */
class FloatingVideoStore {
  private value: FloatingVideo | null = null;
  private readonly listeners = new Set<Listener>();

  get = (): FloatingVideo | null => this.value;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  open(objectId: string, vehicle: string, channels: number[], selected?: number[]): void {
    const pick = (selected ?? []).filter((c) => channels.includes(c));
    this.value = { objectId, vehicle, channels, selected: pick.length ? pick : channels.slice(0, 1) };
    this.emit();
  }

  select(selected: number[]): void {
    if (!this.value || !selected.length) return;
    this.value = { ...this.value, selected };
    this.emit();
  }

  close(): void {
    this.value = null;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const floatingVideo = new FloatingVideoStore();

export function useFloatingVideo(): FloatingVideo | null {
  return useSyncExternalStore(floatingVideo.subscribe, floatingVideo.get, floatingVideo.get);
}
