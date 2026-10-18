import { BRAND_COLORS, BRAND_PIN_PATH, BRAND_PIN_TRANSFORM, BRAND_ROUTE_DOTS, type BrandColors } from '@veetracer/shared';
import { View } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { Text } from '@/components/ui';
import { useTheme } from '@/lib/theme';

/** Logo colours of the selected theme. */
export function useBrandColors(): BrandColors {
  return BRAND_COLORS[useTheme()];
}

/**
 * VeeTrax mark (dotted trip line ending in a map pin) in the theme's colours.
 * `tile` draws it on the rounded brand tile (like the app icon); `onLight` uses the ink colours for plain light
 * backgrounds; otherwise it is the white pin for dark / brand-coloured backgrounds.
 */
export function BrandMark({ size = 48, tile, onLight }: { size?: number; tile?: boolean; onLight?: boolean }) {
  const b = useBrandColors();
  const pin = !tile && onLight ? b.ink : b.pin;
  const route = !tile && onLight ? b.inkRoute : b.route;
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {tile && <Rect width={64} height={64} rx={15} fill={b.tile} />}
      <G transform={tile ? 'translate(5 6) scale(0.84)' : undefined}>
        <Circle cx={10} cy={54} r={5} fill={route} />
        {BRAND_ROUTE_DOTS.map(([cx, cy]) => (
          <Circle key={cx} cx={cx} cy={cy} r={2.4} fill={route} />
        ))}
        <Path d={BRAND_PIN_PATH} fill={pin} fillRule="evenodd" transform={BRAND_PIN_TRANSFORM} />
      </G>
    </Svg>
  );
}

/** Tile mark + "VeeTrax" wordmark, for headers and about screens. */
export function BrandLockup({ size = 36, color, sub }: { size?: number; color: string; sub?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <BrandMark size={size} tile />
      <View>
        <Text style={{ color, fontSize: size * 0.62, fontWeight: '800', letterSpacing: -0.6 }}>VeeTrax</Text>
        {sub ? (
          <Text size="xs" tone="muted">
            {sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
