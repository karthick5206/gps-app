import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import { basemapStyle, BASEMAP_TYPES, type BasemapType, type MapsConfigDto } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { MAP_STYLE } from '@/lib/config';
import { useScheme } from '@/lib/theme';

/**
 * Map type of the switcher (Standard / Light / Satellite), saved on the device, and the server's satellite imagery
 * settings (`GET /maps/config`, loaded once after sign-in). Same choices and styles as the web app.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const KEY = 'vt.basemap';
let type: BasemapType = 'standard';
let config: MapsConfigDto | null = null;
let loading = false;

const emit = () => listeners.forEach((l) => l());

export const basemap = {
  get: () => type,
  satellite: () => config?.satellite ?? null,
  set(next: BasemapType) {
    if (next === type) return;
    type = next;
    SecureStore.setItemAsync(KEY, next).catch(() => undefined);
    emit();
  },
  async restore() {
    try {
      const v = await SecureStore.getItemAsync(KEY);
      if (v && (BASEMAP_TYPES as readonly string[]).includes(v)) basemap.set(v as BasemapType);
    } catch {
      /* keystore unavailable: default */
    }
  },
  ensureConfig() {
    if (config || loading) return;
    loading = true;
    api
      .get<MapsConfigDto>('/maps/config')
      .then((c) => {
        config = c;
        emit();
      })
      .catch(() => undefined)
      .finally(() => {
        loading = false;
      });
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Basemap type and whether Satellite can be offered. */
export function useBasemap() {
  const t = useSyncExternalStore(basemap.subscribe, basemap.get);
  const satellite = useSyncExternalStore(basemap.subscribe, basemap.satellite);
  useEffect(() => basemap.ensureConfig(), []);
  return { type: t === 'satellite' && !satellite ? ('standard' as const) : t, satelliteAvailable: !!satellite };
}

/** Style for <Map mapStyle>: the chosen map type in the current theme. */
export function useMapStyle(): string | StyleSpecification {
  const scheme = useScheme();
  const t = useSyncExternalStore(basemap.subscribe, basemap.get);
  const satellite = useSyncExternalStore(basemap.subscribe, basemap.satellite);
  useEffect(() => basemap.ensureConfig(), []);
  return useMemo(() => basemapStyle(t, scheme, satellite, MAP_STYLE) as string | StyleSpecification, [t, scheme, satellite]);
}
