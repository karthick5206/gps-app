import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** VeeTrax Tracker mark (same artwork as the app icon): a phone broadcasting a person pin with the amber trail. */
export function TrackerLogo({ size = 72 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 108 108" accessibilityLabel="VeeTrax Tracker">
      <Rect width={108} height={108} rx={24} fill="#0e5e57" />
      <Rect x={36} y={20} width={36} height={66} rx={8} fill="#0b3b36" stroke="#fff" strokeWidth={4.5} />
      <Circle cx={54} cy={78} r={2.4} fill="#fff" />
      <Path d="M60 30c-7.2 0-11.8 5-11.8 11.2 0 8.2 11.8 20 11.8 20s11.8-11.8 11.8-20C71.8 35 67.2 30 60 30z" fill="#fff" />
      <Circle cx={60} cy={39.4} r={3.9} fill="#0b3b36" />
      <Path d="M53.6 50.4c1-4.2 3.5-6.3 6.4-6.3s5.4 2.1 6.4 6.3z" fill="#0b3b36" />
      <Circle cx={42} cy={68} r={3.4} fill="#ffb443" />
      <Circle cx={47.5} cy={64.5} r={2.6} fill="#ffb443" />
      <Circle cx={52.3} cy={61} r={2.1} fill="#ffb443" />
      <Path
        d="M80 36a13 13 0 0 1 0 18M86 30.5a21 21 0 0 1 0 29M28 36a13 13 0 0 0 0 18M22 30.5a21 21 0 0 0 0 29"
        fill="none"
        stroke="#ffb443"
        strokeWidth={4}
        strokeLinecap="round"
      />
    </Svg>
  );
}
