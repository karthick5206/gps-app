import { Children, useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMotionAllowed } from '@/lib/motion';
import { useColors, type Colors } from '@/lib/theme';

export type Tone = 'success' | 'warn' | 'danger' | 'idle' | 'primary';

/** Tinted background + readable text + solid dot colour for a status tone. */
export function toneColors(c: Colors, tone: Tone): { bg: string; fg: string; dot: string } {
  switch (tone) {
    case 'success':
      return { bg: c.successSoft, fg: c.successText, dot: c.success };
    case 'warn':
      return { bg: c.accentSoft, fg: c.accentText, dot: c.accent };
    case 'danger':
      return { bg: c.dangerSoft, fg: c.dangerText, dot: c.danger };
    case 'primary':
      return { bg: c.primarySoft, fg: c.primary, dot: c.primary };
    default:
      return { bg: c.idleSoft, fg: c.muted, dot: c.idle };
  }
}

/** White card, 1px border, 12px corners, no shadow. `warn` / `danger` tint it. */
export function Card({ children, tone, style }: { children: ReactNode; tone?: 'warn' | 'danger'; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const bg = tone === 'warn' ? c.accentSoft : tone === 'danger' ? c.dangerSoft : c.card;
  const border = tone === 'warn' ? c.accent : tone === 'danger' ? c.danger : c.border;
  return <View style={[styles.card, { backgroundColor: bg, borderColor: border }, style]}>{children}</View>;
}

/** Small uppercase bold muted heading above a group. */
export function SectionLabel({ children, icon, style }: { children: ReactNode; icon?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.sectionHead, style]}>
      {icon}
      <Text style={[styles.sectionLabel, { color: c.muted }]} accessibilityRole="header">
        {children}
      </Text>
    </View>
  );
}

/** A card of rows separated by hairlines (like a settings list), with an optional section label. */
export function Section({ title, icon, children, style }: { title?: string; icon?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }, style]}>
      {title ? <SectionLabel icon={icon} style={styles.sectionTitle}>{title}</SectionLabel> : null}
      {items.map((child, i) => (
        <View key={i} style={[styles.sectionItem, (title || i > 0) && { borderTopWidth: 1, borderTopColor: c.divider }]}>
          {child}
        </View>
      ))}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.title, { color: c.text }]}>{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return <Text style={[styles.body, { color: muted ? c.muted : c.text }, style]}>{children}</Text>;
}

/** Soft tinted status chip. Wraps when the text is a sentence. */
export function Chip({ label, tone = 'idle', dot, style }: { label: string; tone?: Tone; dot?: ReactNode | boolean; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const t = toneColors(c, tone);
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }, style]}>
      {dot === true ? <View style={[styles.chipDot, { backgroundColor: t.dot }]} /> : dot || null}
      <Text style={[styles.chipText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

type Variant = 'primary' | 'outline' | 'danger' | 'accent' | 'ghost';

export function Button({ title, onPress, variant = 'primary', busy, disabled, icon }: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  busy?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const c = useColors();
  const bg = { primary: c.primary, danger: c.danger, accent: c.accent, outline: c.card, ghost: 'transparent' }[variant];
  const fg = { primary: c.primaryText, danger: '#ffffff', accent: '#1f1300', outline: c.primary, ghost: c.muted }[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          borderColor: variant === 'outline' ? c.primary : 'transparent',
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !off ? 0.98 : 1 }],
        },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** Label on the left, value (or a status chip) on the right. */
export function Row({ label, value, valueColor, chip }: { label: string; value: string; valueColor?: string; chip?: Tone }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: c.muted }]}>{label}</Text>
      {chip ? (
        <Chip label={value} tone={chip} dot style={styles.rowChip} />
      ) : (
        <Text style={[styles.rowValue, { color: valueColor ?? c.text }]} numberOfLines={2}>
          {value}
        </Text>
      )}
    </View>
  );
}

/**
 * Brand header band for screens without the stack header (home, sign-in): fills behind the status bar, white text.
 * `children` sit under the title row (e.g. the language switch, a picture).
 */
export function HeaderBand({ logo, title, subtitle, right, children, style }: {
  logo?: ReactNode;
  title: string;
  subtitle?: string | null;
  right?: ReactNode;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, { backgroundColor: c.header, paddingTop: insets.top + 12 }, style]}>
      <View style={styles.bandRow}>
        {logo}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.bandTitle, { color: c.headerText }]} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.bandSubtitle, { color: c.headerMuted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

/** Round 44px icon button for the header band. */
export function HeaderIconButton({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.headerIcon, { backgroundColor: pressed ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.12)' }]}
    >
      {icon}
    </Pressable>
  );
}

/**
 * Fades and scales its content in once when `play` turns true (e.g. a fresh check-in). Plain with reduce motion.
 */
export function Appear({ play, children, style }: { play: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const motion = useMotionAllowed();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!play || !motion) return;
    v.setValue(0);
    const anim = Animated.timing(v, { toValue: 1, duration: 420, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true });
    anim.start();
    return () => {
      anim.stop();
      v.setValue(1);
    };
    // Only on the false → true change of `play`; motion turning on later must not replay it.
  }, [play]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  return <Animated.View style={[style, { opacity: v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }), transform: [{ scale }] }]}>{children}</Animated.View>;
}

export const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 10 },
  section: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  sectionItem: { paddingHorizontal: 14, paddingVertical: 10, minHeight: 48, justifyContent: 'center', gap: 10 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionLabel: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  button: {
    minHeight: 52,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 28 },
  rowLabel: { fontSize: 15, flexShrink: 1 },
  rowValue: { fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  rowChip: { alignSelf: 'center' },
  band: { paddingHorizontal: 16, paddingBottom: 16, gap: 14 },
  bandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  bandTitle: { fontSize: 21, fontWeight: '800', letterSpacing: 0.2 },
  bandSubtitle: { fontSize: 13, marginTop: 1 },
  headerIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
