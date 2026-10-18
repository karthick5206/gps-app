import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

/** Small set of themed primitives shared by every screen. */

type Tone = 'default' | 'muted' | 'primary' | 'destructive';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const FONT: Record<Size, number> = { xs: 11, sm: 13, md: 15, lg: 18, xl: 24 };

export function Text({ tone = 'default', size = 'md', weight, style, ...props }: TextProps & { tone?: Tone; size?: Size; weight?: '400' | '500' | '600' | '700' }) {
  const c = useColors();
  const color = tone === 'muted' ? c.mutedForeground : tone === 'primary' ? c.primary : tone === 'destructive' ? c.destructive : c.foreground;
  return <RNText {...props} style={[{ color, fontSize: FONT[size], fontWeight: weight }, style]} />;
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const c = useColors();
  const base = [styles.card, { backgroundColor: c.card, borderColor: c.border }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.7 }]}>
      {children}
    </Pressable>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon: Icon,
  loading,
  disabled,
  style,
  ...props
}: Omit<PressableProps, 'style'> & { title: string; variant?: 'primary' | 'outline' | 'ghost' | 'destructive'; icon?: LucideIcon; loading?: boolean; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const bg = variant === 'primary' ? c.primary : variant === 'destructive' ? c.destructive : 'transparent';
  const fg = variant === 'primary' ? c.primaryForeground : variant === 'destructive' ? '#ffffff' : c.foreground;
  return (
    <Pressable
      {...props}
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'outline' ? c.border : bg },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : Icon ? <Icon size={18} color={fg} /> : null}
      <RNText style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{title}</RNText>
    </Pressable>
  );
}

export function Field({ label, error, hint, ...props }: TextInputProps & { label: string; error?: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text size="sm" weight="500">
        {label}
      </Text>
      <TextInput
        placeholderTextColor={c.mutedForeground}
        {...props}
        style={[styles.input, { borderColor: error ? c.destructive : c.border, backgroundColor: c.card, color: c.foreground }, props.style]}
      />
      {error ? (
        <Text size="xs" tone="destructive">
          {error}
        </Text>
      ) : hint ? (
        <Text size="xs" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function SearchInput(props: TextInputProps) {
  const c = useColors();
  return (
    <TextInput
      placeholderTextColor={c.mutedForeground}
      autoCorrect={false}
      autoCapitalize="none"
      clearButtonMode="while-editing"
      {...props}
      style={[styles.input, { borderColor: c.border, backgroundColor: c.card, color: c.foreground }, props.style]}
    />
  );
}

export function Pill({ label, color, style }: { label: string; color: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.pill, { backgroundColor: `${color}22` }, style]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <RNText style={{ color, fontSize: 12, fontWeight: '600' }}>{label}</RNText>
    </View>
  );
}

/** Horizontal choice chips (status filters, tabs inside a screen). */
export function Chips<T extends string>({ options, value, onChange }: { options: { value: T; label: string; color?: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.chip, { borderColor: active ? c.primary : c.border, backgroundColor: active ? c.accent : c.card }]}
          >
            {o.color && <View style={[styles.dot, { backgroundColor: o.color }]} />}
            <RNText style={{ color: active ? c.primary : c.foreground, fontSize: 13, fontWeight: active ? '600' : '500' }}>
              {o.label}
              {o.count !== undefined ? ` ${o.count}` : ''}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.muted }]}>
        <Icon size={26} color={c.mutedForeground} />
      </View>
      <Text weight="600">{title}</Text>
      {description && (
        <Text size="sm" tone="muted" style={{ textAlign: 'center' }}>
          {description}
        </Text>
      )}
      {action}
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View style={[styles.banner, { borderColor: `${c.destructive}55`, backgroundColor: `${c.destructive}12` }]}>
      <Text size="sm" tone="destructive" style={{ flex: 1 }}>
        {message}
      </Text>
      {onRetry && (
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text size="sm" weight="600" tone="destructive">
            Retry
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** Label / value row for detail screens. */
export function InfoRow({ label, value, valueStyle }: { label: string; value: ReactNode; valueStyle?: StyleProp<TextStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.infoRow, { borderBottomColor: c.border }]}>
      <Text size="sm" tone="muted">
        {label}
      </Text>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text size="sm" weight="500" style={[{ flexShrink: 1, textAlign: 'right' }, valueStyle]}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" tone="muted" weight="600" style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginTop: SPACE.sm }}>
      {children}
    </Text>
  );
}

export const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, paddingHorizontal: SPACE.lg, borderRadius: RADIUS.sm, borderWidth: 1 },
  input: { height: 46, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, fontSize: 15 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full, alignSelf: 'flex-start' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: RADIUS.full, borderWidth: 1 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, padding: SPACE.xl, flex: 1 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.xs },
  banner: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.md },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
