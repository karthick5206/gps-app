import { STATUS_META, TRACK_STATUS_CODES } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import { RADIUS, SPACE, statusColor, useColors, type Scheme } from '@/lib/theme';

export type ColorMode = 'status' | 'speed';

/** Colours of the speed bands (< 20, < 40, < 60, < 80, ≥ 80 km/h), same as the web replay. */
export const SPEED_BAND_COLORS: Record<Scheme, string[]> = {
  light: ['#2563eb', '#16a34a', '#ca8a04', '#ea580c', '#dc2626'],
  dark: ['#60a5fa', '#4ade80', '#facc15', '#fb923c', '#f87171'],
};
export const SPEED_BAND_LABELS = ['< 20', '20–40', '40–60', '60–80', '80+'];

/** MapLibre colour expression for the track runs (`s` = status code, `b` = speed band). */
export function trackColorExpr(mode: ColorMode, scheme: Scheme) {
  const pairs = mode === 'status' ? TRACK_STATUS_CODES.flatMap((s, i) => [i, statusColor(s, scheme)]) : SPEED_BAND_COLORS[scheme].flatMap((c, i) => [i, c]);
  return ['match', ['get', mode === 'status' ? 's' : 'b'], ...pairs, STATUS_META.NO_DATA[scheme]];
}

function Swatch({ color, label, dot = false }: { color: string; label: string; dot?: boolean }) {
  return (
    <View style={styles.item}>
      <View style={dot ? [styles.dot, { backgroundColor: color }] : [styles.bar, { backgroundColor: color }]} />
      <Text size="xs">{label}</Text>
    </View>
  );
}

/** Replay map legend: what each track colour and stop dot means, with a Status / Speed toggle. */
export function TrackLegend({ mode, onModeChange, scheme }: { mode: ColorMode; onModeChange: (m: ColorMode) => void; scheme: Scheme }) {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <View style={[styles.box, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={[styles.toggle, { backgroundColor: c.muted }]} accessibilityRole="radiogroup" accessibilityLabel={t('Colour track by')}>
        {(['status', 'speed'] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => onModeChange(m)}
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === m }}
            style={[styles.toggleBtn, mode === m && { backgroundColor: c.card }]}
          >
            <Text size="xs" weight={mode === m ? '600' : '400'} tone={mode === m ? undefined : 'muted'}>
              {m === 'status' ? t('Status') : t('Speed')}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.items}>
        {mode === 'status'
          ? TRACK_STATUS_CODES.map((s) => <Swatch key={s} color={statusColor(s, scheme)} label={t(STATUS_META[s].label)} />)
          : SPEED_BAND_LABELS.map((l, i) => <Swatch key={l} color={SPEED_BAND_COLORS[scheme][i]} label={`${l} km/h`} />)}
        <Swatch color={STATUS_META.OFFLINE[scheme]} label={t('No data (gap)')} />
        <Swatch dot color={statusColor('IDLE', scheme)} label={t('Idle stop')} />
        <Swatch dot color={statusColor('OFF', scheme)} label={t('Parked')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', right: SPACE.sm, top: SPACE.sm, maxWidth: 190, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.xs, gap: SPACE.xs, opacity: 0.96 },
  toggle: { flexDirection: 'row', borderRadius: RADIUS.sm, padding: 2 },
  toggleBtn: { flex: 1, alignItems: 'center', paddingVertical: 3, borderRadius: RADIUS.sm - 2 },
  items: { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm, rowGap: 2, paddingHorizontal: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 80 },
  bar: { width: 14, height: 4, borderRadius: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: '#ffffff' },
});
