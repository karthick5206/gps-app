import { Camera, GeoJSONSource, Images, Layer, Map, type CameraRef } from '@maplibre/maplibre-react-native';
import { useQuery } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, STATUS_META, type HistoryResponse } from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { PauseIcon, PlayIcon, RouteIcon, SkipBackIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SeekBar } from '@/components/SeekBar';
import { Card, Chips, EmptyState, ErrorBanner, Text } from '@/components/ui';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { formatClock, formatKm, trackStatus } from '@/features/history/history-format';
import { PlaybackAddress } from '@/features/history/PlaybackAddress';
import { buildRuns, buildTrackIndex, coordsOf, PLAYBACK_RATES, type PlaybackRate, type Sample } from '@/features/history/playback-core';
import { TrackLegend, trackColorExpr, type ColorMode } from '@/features/history/TrackLegend';
import { PlaybackEngine } from '@/features/history/playback-engine';
import { presetRange, type RangePreset } from '@/features/history/time-range';
import { useDisplay } from '@/features/display/display';
import { liveStore } from '@/features/live/live-store';
import { iconKind, iconName, rotates } from '@/features/map/vehicle-icons';
import { VEHICLE_ICON_IMAGES } from '@/features/map/vehicle-icon-images';
import { api, errorMessage } from '@/lib/api';
import { MAP_STYLE } from '@/lib/config';
import { formatDuration } from '@/lib/format';
import { RADIUS, SPACE, statusColor, useColors, useScheme } from '@/lib/theme';

type Preset = Exclude<RangePreset, 'custom'>;
type Tab = 'trips' | 'stops' | 'alerts';
/** Map marker refresh rate while playing (the bridge can't take 60 GeoJSON updates a second). */
const MARKER_FPS = 12;

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexBasis: '31%', flexGrow: 1 }}>
      <Text size="xs" tone="muted">
        {label}
      </Text>
      <Text weight="600">{value}</Text>
    </View>
  );
}

export default function HistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  const vehicle = liveStore.get(id);
  const [preset, setPreset] = useState<Preset>('today');
  const [tab, setTab] = useState<Tab>('trips');
  const [colorMode, setColorMode] = useState<ColorMode>('status');
  const range = useMemo(() => presetRange(preset), [preset]);
  const camera = useRef<CameraRef>(null);
  const { iconScale } = useDisplay();

  const history = useQuery({
    queryKey: ['history', id, range.from.toISOString(), range.to.toISOString()],
    queryFn: ({ signal }) => api.get<HistoryResponse>(`/objects/${id}/history`, { from: range.from.toISOString(), to: range.to.toISOString() }, signal),
  });
  const h = history.data;

  const index = useMemo(() => (h && h.points.length ? buildTrackIndex(h.points) : null), [h]);
  const engine = useMemo(() => (index ? new PlaybackEngine(index) : null), [index]);
  useEffect(() => () => engine?.destroy(), [engine]);

  const noop = () => () => {};
  const state = useSyncExternalStore(engine?.subscribe ?? noop, engine?.getState ?? (() => null));
  const [sample, setSample] = useState<Sample | null>(null);
  useEffect(() => {
    if (!engine) return setSample(null);
    let last = 0;
    return engine.onFrame((s, info) => {
      const now = Date.now();
      if (!info.force && now - last < 1000 / MARKER_FPS) return;
      last = now;
      setSample(s);
    });
  }, [engine]);

  // Frame the whole track when it loads.
  useEffect(() => {
    if (!h || !h.points.length) return;
    let w = 180, s = 90, e = -180, n = -90;
    for (const p of h.points) {
      w = Math.min(w, p[2]);
      e = Math.max(e, p[2]);
      s = Math.min(s, p[1]);
      n = Math.max(n, p[1]);
    }
    setTimeout(() => camera.current?.fitBounds([w, s, e, n], { padding: { top: 40, bottom: 40, left: 40, right: 40 }, duration: 0 }), 300);
  }, [h]);

  // One feature per run of equal status / speed band, so the line can be coloured by either.
  const track = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features:
        index && index.n > 1
          ? buildRuns(index).map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coordsOf(index, r.a, r.b) }, properties: { s: r.status, b: r.band, gap: r.gap } }))
          : [],
    }),
    [index],
  );
  const stops = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: (h?.stops ?? []).map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { idle: s.ignitionOn } })) }),
    [h],
  );
  const kind = vehicle ? iconKind(vehicle) : 'OTHER';
  const marker = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!sample) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [sample.lng, sample.lat] }, properties: { icon: iconName(kind, trackStatus(sample.status)), rot: rotates(kind) ? sample.bearing : 0 } }],
    };
  }, [sample, kind]);

  const cycleRate = () => {
    if (!engine || !state) return;
    const i = PLAYBACK_RATES.indexOf(state.rate);
    engine.setRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length] as PlaybackRate);
  };

  const title = vehicle ? vehicle.plateNumber || vehicle.name : t('History');
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: t('History · {{name}}', { name: title }) }} />
      <View style={{ padding: SPACE.md, paddingBottom: SPACE.sm }}>
        <Chips
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'today', label: t('Today') },
            { value: 'yesterday', label: t('Yesterday') },
            { value: 'last7', label: t('Last 7 days') },
          ]}
        />
      </View>

      <View style={{ height: 300 }}>
        <Map style={{ flex: 1 }} mapStyle={MAP_STYLE[scheme]} logo={false} attributionPosition={{ bottom: 4, left: 8 }} touchPitch={false}>
          <Camera ref={camera} initialViewState={vehicle?.lat != null && vehicle.lng != null ? { center: [vehicle.lng, vehicle.lat], zoom: 12 } : { center: [78.9, 21.5], zoom: 4 }} />
          <Images images={VEHICLE_ICON_IMAGES} />
          <GeoJSONSource id="track" data={track}>
            <Layer id="track-casing" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 }} />
            <Layer id="track-line" type="line" filter={['!', ['get', 'gap']]} layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-color': trackColorExpr(colorMode, scheme) as never, 'line-width': 3.5 }} />
            <Layer id="track-gap" type="line" filter={['get', 'gap']} paint={{ 'line-color': STATUS_META.OFFLINE[scheme], 'line-width': 3, 'line-dasharray': [1.5, 1.5] }} />
          </GeoJSONSource>
          <GeoJSONSource id="stops" data={stops}>
            <Layer
              id="stops-dot"
              type="circle"
              paint={{ 'circle-radius': 6, 'circle-color': ['case', ['get', 'idle'], statusColor('IDLE', scheme), statusColor('OFF', scheme)], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' }}
            />
          </GeoJSONSource>
          <GeoJSONSource id="cursor" data={marker}>
            <Layer id="cursor-icon" type="symbol" layout={{ 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': 1.1 * iconScale }} />
          </GeoJSONSource>
        </Map>
        {index && index.n > 1 && <TrackLegend mode={colorMode} onModeChange={setColorMode} scheme={scheme} />}
        {history.isFetching && (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000022' }]}>
            <ActivityIndicator color={c.primary} size="large" />
          </View>
        )}
      </View>

      {history.isError && (
        <View style={{ padding: SPACE.md }}>
          <ErrorBanner message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
        </View>
      )}

      {h && !index && !history.isFetching && <EmptyState icon={RouteIcon} title={t('No movement data')} description={t('Nothing was recorded for this vehicle in the selected period.')} />}

      {h && index && engine && state && (
        <>
          <View style={[styles.player, { borderBottomColor: c.border, backgroundColor: c.card }]}>
            <Pressable onPress={() => engine.seek(index.start)} hitSlop={8} accessibilityLabel={t('Back to start')}>
              <SkipBackIcon size={20} color={c.foreground} />
            </Pressable>
            <Pressable onPress={() => engine.toggle()} style={[styles.play, { backgroundColor: c.primary }]} accessibilityLabel={state.playing ? t('Pause') : t('Play')}>
              {state.playing ? <PauseIcon size={20} color={c.primaryForeground} /> : <PlayIcon size={20} color={c.primaryForeground} />}
            </Pressable>
            <View style={{ flex: 1 }}>
              <SeekBar min={index.start} max={index.end} value={sample?.t ?? index.start} onSeek={(t) => engine.seek(t, { play: state.playing })} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12 }}>
                <Text size="xs" tone="muted">
                  {sample ? formatClock(sample.t, preset === 'last7') : ''}
                </Text>
                <Text size="xs" tone="muted">
                  {sample ? `${Math.round(sample.speed)} km/h · ${formatKm(sample.distKm)}` : ''}
                </Text>
              </View>
            </View>
            <Pressable onPress={cycleRate} style={[styles.rate, { borderColor: c.border }]} accessibilityLabel={t('Playback speed')}>
              <Text size="sm" weight="600">
                {state.rate}×
              </Text>
            </Pressable>
          </View>
          {sample && (
            <View style={{ backgroundColor: c.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
              <PlaybackAddress lat={sample.lat} lng={sample.lng} playing={state.playing} />
            </View>
          )}

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}>
            <Card style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: SPACE.md, columnGap: SPACE.sm }}>
              <SummaryStat label={t('Distance')} value={formatKm(h.summary.distanceKm)} />
              <SummaryStat label={t('Running')} value={formatDuration(h.summary.runningSec)} />
              <SummaryStat label={t('Idle')} value={formatDuration(h.summary.idleSec)} />
              <SummaryStat label={t('Stopped')} value={formatDuration(h.summary.stopSec)} />
              <SummaryStat label={t('Max speed')} value={`${Math.round(h.summary.maxSpeedKph)} km/h`} />
              <SummaryStat label={t('Avg speed')} value={`${Math.round(h.summary.avgSpeedKph)} km/h`} />
            </Card>
            {h.truncated && (
              <Text size="xs" tone="muted">
                {t('Long period: the track was simplified for display.')}
              </Text>
            )}

            <Chips
              value={tab}
              onChange={setTab}
              options={[
                { value: 'trips', label: t('Trips'), count: h.trips.length },
                { value: 'stops', label: t('Stops'), count: h.stops.length },
                { value: 'alerts', label: t('Alerts'), count: h.alerts.length },
              ]}
            />

            {tab === 'trips' &&
              h.trips.map((trip, i) => (
                <Card key={trip.id} onPress={() => engine.seek(Date.parse(trip.startTime), { play: true, until: Date.parse(trip.endTime) })}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text weight="600">{t('Trip {{n}}', { n: i + 1 })}</Text>
                    <Text size="sm" weight="600">
                      {formatKm(trip.distanceKm)}
                    </Text>
                  </View>
                  <Text size="sm" tone="muted">
                    {formatClock(Date.parse(trip.startTime), preset === 'last7', false)} → {formatClock(Date.parse(trip.endTime), false, false)} · {formatDuration(trip.durationSec)} · {t('max {{speed}} km/h', { speed: Math.round(trip.maxSpeedKph) })}
                  </Text>
                  {(trip.startAddress || trip.endAddress) && (
                    <Text size="xs" tone="muted" numberOfLines={2}>
                      {trip.startAddress ?? '—'} → {trip.endAddress ?? '—'}
                    </Text>
                  )}
                </Card>
              ))}

            {tab === 'stops' &&
              h.stops.map((s) => (
                <Card
                  key={s.id}
                  onPress={() => {
                    engine.seek(Date.parse(s.startTime));
                    camera.current?.easeTo({ center: [s.lng, s.lat], zoom: 16, duration: 500 });
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor(s.ignitionOn ? 'IDLE' : 'OFF', scheme) }} />
                    <Text weight="600" style={{ flex: 1 }}>
                      {s.ignitionOn ? t('Idle stop') : t('Parked')} · {formatDuration(s.durationSec)}
                    </Text>
                    <Text size="sm" tone="muted">
                      {formatClock(Date.parse(s.startTime), preset === 'last7', false)}
                    </Text>
                  </View>
                  {s.address && (
                    <Text size="xs" tone="muted" numberOfLines={2}>
                      {s.address}
                    </Text>
                  )}
                </Card>
              ))}

            {tab === 'alerts' && (
              <FlatList
                scrollEnabled={false}
                data={h.alerts}
                keyExtractor={(a) => a.id}
                contentContainerStyle={{ gap: SPACE.sm }}
                renderItem={({ item: a }) => (
                  <Card onPress={() => engine.seek(Date.parse(a.occurredAt))}>
                    <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'center' }}>
                      <AlertTypeIcon type={a.type} severity={a.severity} size={30} />
                      <View style={{ flex: 1 }}>
                        <Text weight="600">{t(ALERT_TYPE_MAP[a.type]?.label ?? a.type)}</Text>
                        <Text size="xs" tone="muted" numberOfLines={1}>
                          {formatClock(Date.parse(a.occurredAt), preset === 'last7', false)} · {a.message}
                        </Text>
                      </View>
                    </View>
                  </Card>
                )}
              />
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  player: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  play: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  rate: { minWidth: 40, height: 32, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
});
