import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Trip dots along the brand curve (scripts/brand/generate.mjs). */
const ROUTE_DOTS = [
  [20.06, 52.72],
  [27.5, 49.75],
  [34.19, 46.41],
  [42, 44],
];
const PIN = 'M32 5C20.4 5 11 14.2 11 25.6 11 40.5 32 59 32 59s21-18.5 21-33.4C53 14.2 43.6 5 32 5z M24 25.6a8 8 0 1 0 16 0a8 8 0 1 0-16 0z';

/** Veetrax mark (dotted trip line ending in a map pin); `tile` draws it on a rounded square. */
export function BrandMark({ size = 48, pin, route, tile }: { size?: number; pin: string; route: string; tile?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {tile && <Rect width={64} height={64} rx={15} fill={tile} />}
      <Circle cx={10} cy={54} r={5} fill={route} transform={tile ? 'translate(5 6) scale(0.84)' : undefined} />
      {ROUTE_DOTS.map(([cx, cy]) => (
        <Circle key={cx} cx={cx} cy={cy} r={2.4} fill={route} transform={tile ? 'translate(5 6) scale(0.84)' : undefined} />
      ))}
      <Path d={PIN} fill={pin} fillRule="evenodd" transform={tile ? 'translate(5 6) scale(0.84) translate(24 0) scale(0.72)' : 'translate(24 0) scale(0.72)'} />
    </Svg>
  );
}
