import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { useColors } from '@/lib/theme';

export function Card({ children, tone, style }: { children: ReactNode; tone?: 'warn' | 'danger'; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const bg = tone === 'warn' ? c.accentSoft : tone === 'danger' ? c.dangerSoft : c.card;
  const border = tone === 'warn' ? c.accent : tone === 'danger' ? c.danger : c.border;
  return <View style={[styles.card, { backgroundColor: bg, borderColor: border }, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.title, { color: c.text }]}>{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return <Text style={[styles.body, { color: muted ? c.muted : c.text }, style]}>{children}</Text>;
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
  const bg = { primary: c.primary, danger: c.danger, accent: c.accent, outline: 'transparent', ghost: 'transparent' }[variant];
  const fg = { primary: c.primaryText, danger: '#ffffff', accent: '#1f1300', outline: c.primary, ghost: c.muted }[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'outline' ? c.primary : 'transparent', opacity: off ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** Label on the left, value on the right. */
export function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: c.muted }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: valueColor ?? c.text }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10 },
  title: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  button: {
    minHeight: 50,
    borderRadius: 12,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  rowLabel: { fontSize: 15 },
  rowValue: { fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
