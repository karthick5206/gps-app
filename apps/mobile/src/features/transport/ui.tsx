import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { BusIcon, CheckCircle2Icon, ClockIcon, XCircleIcon } from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Card, EmptyState, Text } from '@/components/ui';
import { useDisplay } from '@/features/display/display';
import { SELF_HOSTED_MAP_STYLE } from '@/lib/config';
import { RADIUS, SPACE, toneColors, useColors, useScheme, type Tone } from '@/lib/theme';
import type { ActionDisplay } from './event-queue';

/** Minimum touch target for transport screens (48 dp, doc 08 §6.2). */
export const TOUCH = 48;

/** Status chip: tone colour AND a word (status is never shown by colour alone). */
export function StatusChip({ label, tone, icon: Icon }: { label: string; tone: Tone; icon?: LucideIcon }) {
  const c = useColors();
  const { textScale } = useDisplay();
  const tc = toneColors(c, tone);
  return (
    <View style={[styles.chip, { backgroundColor: tc.soft }]} accessible accessibilityLabel={label}>
      {Icon ? <Icon size={14} color={tc.text} /> : <View style={[styles.dot, { backgroundColor: tc.text }]} />}
      <Text style={{ color: tc.text, fontSize: 12 * textScale, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

/** Pending / confirmed / rejected badge of a driver action (doc 09 §6.5). */
export function SyncBadge({ state, code }: { state: ActionDisplay; code?: string | null }) {
  const { t } = useTranslation();
  if (state === 'NONE') return null;
  if (state === 'CONFIRMED') return <StatusChip label={t('Confirmed')} tone="success" icon={CheckCircle2Icon} />;
  if (state === 'PENDING') return <StatusChip label={t('Pending sync')} tone="warning" icon={ClockIcon} />;
  if (state === 'LATE') return <StatusChip label={t('Received late: no effect')} tone="neutral" icon={ClockIcon} />;
  return <StatusChip label={code ? t('Rejected: {{code}}', { code }) : t('Rejected')} tone="destructive" icon={XCircleIcon} />;
}

/** Large, labelled action button (≥ 48 dp) used by the driver and passenger screens. */
export function BigAction({
  title,
  hint,
  icon: Icon,
  onPress,
  disabled,
  tone = 'brand',
  style,
}: {
  title: string;
  hint?: string;
  icon?: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  tone?: Tone;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const { textScale } = useDisplay();
  const tc = toneColors(c, tone);
  const solid = tone === 'brand' ? c.primary : tc.solid;
  const fg = tone === 'brand' ? c.primaryForeground : '#ffffff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.big, { backgroundColor: solid }, disabled && { opacity: 0.45 }, pressed && { opacity: 0.8 }, style]}
    >
      {Icon ? <Icon size={22} color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 16 * textScale, fontWeight: '700', flexShrink: 1, textAlign: 'center' }}>{title}</Text>
    </Pressable>
  );
}

/** Empty state for "not linked" / "nothing yet" inside a card. */
export function TransportEmpty({ title, description, icon = BusIcon, action }: { title: string; description?: string; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <Card style={{ paddingVertical: 0 }}>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </Card>
  );
}

export interface MapPoint {
  lat: number;
  lng: number;
  kind: 'pickup' | 'drop' | 'stop' | 'vehicle';
  label?: string;
}

/** Self-hosted style for the current scheme, or null when this build has none (then no map is drawn). */
export function useTransportMapStyle(): string | null {
  const scheme = useScheme();
  return scheme === 'dark' ? (SELF_HOSTED_MAP_STYLE.dark ?? SELF_HOSTED_MAP_STYLE.standard) : (SELF_HOSTED_MAP_STYLE.light ?? SELF_HOSTED_MAP_STYLE.standard);
}

const KIND_COLOR: Record<MapPoint['kind'], string> = { pickup: '#16a34a', drop: '#2563eb', stop: '#6b7280', vehicle: '#ea580c' };

/**
 * Small MapLibre map for transport screens. Uses ONLY the self-hosted style of the build (no OpenFreeMap fallback);
 * returns null without one, so the caller's text description is what the person gets. The map is decorative for
 * screen readers: the caller always shows the same information as text (doc 08 §6.2).
 */
export function TransportMap({ points, label, height = 220 }: { points: MapPoint[]; label: string; height?: number }) {
  const style = useTransportMapStyle();
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const data = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: valid.map((p, i) => ({ type: 'Feature' as const, id: i, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] }, properties: { color: KIND_COLOR[p.kind], vehicle: p.kind === 'vehicle' ? 1 : 0 } })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(valid)],
  );
  if (!style || !valid.length) return null;
  const lngs = valid.map((p) => p.lng);
  const lats = valid.map((p) => p.lat);
  const single = valid.length === 1;
  const camera = single
    ? { center: [valid[0].lng, valid[0].lat] as [number, number], zoom: 15 }
    : { bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] as [number, number, number, number], padding: { top: 40, right: 40, bottom: 40, left: 40 } };
  return (
    <View style={{ height, borderRadius: RADIUS.md, overflow: 'hidden' }} accessible accessibilityRole="image" accessibilityLabel={label}>
      <Map style={{ flex: 1 }} mapStyle={style} logo={false} attributionPosition={{ bottom: 4, left: 8 }}>
        <Camera {...camera} duration={0} />
        <GeoJSONSource id="transport-points" data={data}>
          <Layer id="transport-halo" type="circle" paint={{ 'circle-radius': ['case', ['==', ['get', 'vehicle'], 1], 18, 12], 'circle-color': ['get', 'color'], 'circle-opacity': 0.2 }} />
          <Layer id="transport-dot" type="circle" paint={{ 'circle-radius': ['case', ['==', ['get', 'vehicle'], 1], 9, 6], 'circle-color': ['get', 'color'], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' }} />
        </GeoJSONSource>
      </Map>
    </View>
  );
}

/**
 * WP 3.9 wave 2: tap-to-place map for a one-time point (ride request, home pin). ONLY the build's self-hosted style
 * (same as TransportMap); returns null without one, and the caller's address search / typed position is the way to
 * choose a point. `center` is where the camera starts (the current point, a search hit or a saved place).
 */
export function TransportPickMap({
  point,
  center,
  onPick,
  label,
  height = 240,
}: {
  point: { lat: number; lng: number } | null;
  center: { lat: number; lng: number } | null;
  onPick: (p: { lat: number; lng: number }) => void;
  label: string;
  height?: number;
}) {
  const style = useTransportMapStyle();
  const data = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: point ? [{ type: 'Feature' as const, id: 0, geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] }, properties: { color: KIND_COLOR.pickup } }] : [],
    }),
    [point],
  );
  const at = point ?? center;
  if (!style || !at) return null;
  return (
    <View style={{ height, borderRadius: RADIUS.md, overflow: 'hidden' }} accessibilityLabel={label}>
      <Map style={{ flex: 1 }} mapStyle={style} logo={false} attributionPosition={{ bottom: 4, left: 8 }} touchPitch={false} onPress={(e) => onPick({ lat: e.nativeEvent.lngLat[1], lng: e.nativeEvent.lngLat[0] })}>
        <Camera center={[at.lng, at.lat]} zoom={15} duration={0} />
        <GeoJSONSource id="transport-pick" data={data}>
          <Layer id="transport-pick-halo" type="circle" paint={{ 'circle-radius': 14, 'circle-color': ['get', 'color'], 'circle-opacity': 0.2 }} />
          <Layer id="transport-pick-dot" type="circle" paint={{ 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' }} />
        </GeoJSONSource>
      </Map>
    </View>
  );
}

/** Label / value line that wraps (long stop labels, Hindi / Tamil text at large sizes). */
export function Line({ label, children }: { label: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.line, { borderBottomColor: c.border }]} accessible>
      <Text size="sm" tone="muted">
        {label}
      </Text>
      {typeof children === 'string' ? <Text weight="500">{children}</Text> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.full, alignSelf: 'flex-start' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  big: { minHeight: 56, borderRadius: RADIUS.md, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm },
  line: { paddingVertical: 10, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
});
