import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The route as cubic segments (same road as the web sign-in scene). */
const SEGMENTS: [number, number][][] = [
  [[30, 210], [90, 210], [95, 150], [150, 145]],
  [[150, 145], [205, 140], [215, 95], [265, 100]],
  [[265, 100], [315, 105], [330, 60], [380, 55]],
];
const STEPS = 16;
const DRIVE_MS = 7600;
const HOLD_MS = 1400;
const AMBER = '#ffb443';

/** Points along the route with their cumulative distance (0..1), for the trace and the vehicle position. */
function sampleRoute() {
  const pts: [number, number][] = [];
  for (const [p0, c1, c2, p1] of SEGMENTS) {
    for (let i = pts.length ? 1 : 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      pts.push([a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]]);
    }
  }
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = dist[dist.length - 1];
  return { pts, frac: dist.map((x) => x / total), total, d: `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}` };
}

/**
 * Decorative live-tracking scene for the sign-in screen: street grid, a route drawing itself, a vehicle driving it,
 * a destination pin with radar rings and a geofence. Built-in Animated + react-native-svg; still when the phone
 * has "Remove animations" / reduce motion on.
 */
export function TrackingScene({ color, style }: { color: string; style?: StyleProp<ViewStyle> }) {
  const route = useMemo(sampleRoute, []);
  const progress = useRef(new Animated.Value(0.55)).current;
  const ping = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => mounted && setStill(reduced))
      .catch(() => mounted && setStill(false));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (still) return;
    progress.setValue(0);
    const drive = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: DRIVE_MS, easing: Easing.linear, useNativeDriver: false }),
        Animated.delay(HOLD_MS),
        Animated.timing(progress, { toValue: 0, duration: 0, useNativeDriver: false }),
      ]),
    );
    const pulse = Animated.loop(Animated.timing(ping, { toValue: 1, duration: 2000, easing: Easing.out(Easing.quad), useNativeDriver: false }));
    drive.start();
    pulse.start();
    return () => {
      drive.stop();
      pulse.stop();
    };
  }, [still, progress, ping]);

  const cx = progress.interpolate({ inputRange: route.frac, outputRange: route.pts.map((p) => p[0]) });
  const cy = progress.interpolate({ inputRange: route.frac, outputRange: route.pts.map((p) => p[1]) });
  const dashOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [route.total, 0] });
  const ringR = ping.interpolate({ inputRange: [0, 1], outputRange: [6, 22] });
  const ringOpacity = ping.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });
  const carRingR = ping.interpolate({ inputRange: [0, 1], outputRange: [9, 24] });
  const carRingOpacity = ping.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  return (
    <Svg viewBox="0 20 410 220" style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <G stroke={color} strokeOpacity={0.14} strokeWidth={1}>
        {[40, 90, 140, 190, 240].map((y) => (
          <Line key={`h${y}`} x1={0} x2={410} y1={y} y2={y} />
        ))}
        {[40, 100, 160, 220, 280, 340, 400].map((x) => (
          <Line key={`v${x}`} y1={0} y2={260} x1={x} x2={x} />
        ))}
      </G>
      <Circle cx={150} cy={145} r={34} fill={color} fillOpacity={0.08} stroke={color} strokeOpacity={0.4} strokeDasharray="4 5" />
      <Path d={route.d} fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />
      <AnimatedPath d={route.d} fill="none" stroke={AMBER} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={[route.total, route.total]} strokeDashoffset={dashOffset} />
      <Circle cx={30} cy={210} r={5} fill={color} fillOpacity={0.7} />
      {/* Destination pin with a radar ring */}
      <G transform="translate(380 55)">
        <AnimatedCircle r={ringR} fill="none" stroke={AMBER} strokeWidth={2} opacity={ringOpacity} />
        <Path d="M0 -22 C -9 -22 -14 -15 -14 -9 C -14 0 0 10 0 10 C 0 10 14 0 14 -9 C 14 -15 9 -22 0 -22 Z" fill={AMBER} />
        <Circle cy={-10} r={4.5} fill="#0b3b36" />
      </G>
      {/* Vehicle */}
      <AnimatedCircle cx={cx} cy={cy} r={carRingR} fill={AMBER} opacity={carRingOpacity} />
      <AnimatedCircle cx={cx} cy={cy} r={9} fill={AMBER} stroke="#fff" strokeWidth={2.5} />
    </Svg>
  );
}
