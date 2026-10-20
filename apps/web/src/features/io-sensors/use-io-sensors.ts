import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IO_SENSOR_DEFAULTS, IO_SENSOR_KINDS, type IoSensorConfigDto, type IoSensorKind, type IoSensorsDto, type RecentAttributesDto } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Editable copy of one sensor; voltages are text while typing. */
export interface IoDraft {
  kind: IoSensorKind;
  enabled: boolean;
  source: IoSensorConfigDto['source'];
  attribute: string;
  invert: boolean;
  minV: string;
  maxV: string;
  hysteresisV: string;
  debounceSec: string;
}

const toDraft = (s: Omit<IoSensorConfigDto, 'deviceId' | 'updatedAt'>): IoDraft => ({
  kind: s.kind,
  enabled: s.enabled,
  source: s.source,
  attribute: s.attribute,
  invert: s.invert,
  minV: s.minV === null ? '' : String(s.minV),
  maxV: s.maxV === null ? '' : String(s.maxV),
  hysteresisV: String(s.hysteresisV),
  debounceSec: String(s.debounceSec),
});

const defaults = (): IoDraft[] => IO_SENSOR_KINDS.map((kind) => toDraft({ kind, ...IO_SENSOR_DEFAULTS[kind] }));
export const voltOrNull = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Error text for a draft the API would reject, else null. */
export function draftError(d: IoDraft): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(d.attribute)) return 'Choose the input the sensor is wired to';
  if (d.source !== 'ANALOG' || !d.enabled) return null;
  const min = voltOrNull(d.minV);
  const max = voltOrNull(d.maxV);
  if (min === null && max === null) return 'Enter the minimum and / or maximum voltage';
  if (min !== null && max !== null && min >= max) return 'The minimum voltage must be below the maximum';
  return null;
}

/** AC / door sensor settings of a device (Devices → Advanced settings) plus its live input readings. */
export function useIoSensors(deviceId: string | null, open: boolean) {
  const qc = useQueryClient();
  const path = `/devices/${deviceId}/io-sensors`;
  const q = useQuery({ queryKey: ['io-sensors', deviceId], queryFn: ({ signal }) => api.get<IoSensorsDto>(path, undefined, signal), enabled: !!deviceId && open });
  // Live readings for calibration: refreshed every 10 s while the form is open.
  const recent = useQuery({
    queryKey: ['recent-attributes', deviceId],
    queryFn: ({ signal }) => api.get<RecentAttributesDto>(`/devices/${deviceId}/recent-attributes`, undefined, signal),
    enabled: !!deviceId && open,
    refetchInterval: 10_000,
  });
  const [drafts, setDrafts] = useState<IoDraft[]>(defaults);
  const [initial, setInitial] = useState<string>(JSON.stringify(defaults()));
  useEffect(() => {
    if (!q.data) return;
    const d = q.data.sensors.map(toDraft);
    setDrafts(d);
    setInitial(JSON.stringify(d));
  }, [q.data]);
  const dirty = JSON.stringify(drafts) !== initial;
  const update = (kind: IoSensorKind, patch: Partial<IoDraft>) => setDrafts((all) => all.map((d) => (d.kind === kind ? { ...d, ...patch } : d)));

  /** PUT when changed; returns the first validation error instead of saving. */
  async function save(): Promise<void> {
    if (!deviceId || !dirty) return;
    const bad = drafts.map(draftError).find((e) => e);
    if (bad) throw new Error(bad);
    await api.put(path, {
      sensors: drafts.map((d) => ({
        kind: d.kind,
        enabled: d.enabled,
        source: d.source,
        attribute: d.attribute,
        invert: d.invert,
        minV: voltOrNull(d.minV),
        maxV: voltOrNull(d.maxV),
        hysteresisV: voltOrNull(d.hysteresisV) ?? 0.2,
        debounceSec: Math.max(0, Math.round(voltOrNull(d.debounceSec) ?? 10)),
      })),
    });
    await qc.invalidateQueries({ queryKey: ['io-sensors', deviceId] });
  }

  return { loading: q.isLoading, drafts, update, dirty, save, recent: recent.data?.attributes ?? [], recentLoading: recent.isLoading };
}
export type IoSensorsState = ReturnType<typeof useIoSensors>;
