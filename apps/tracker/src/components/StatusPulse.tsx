import { Animated, StyleSheet, View } from 'react-native';
import { useLoop, useMotionAllowed } from '@/lib/motion';
import { useColors } from '@/lib/theme';
import { toneColors, type Tone } from './ui';

/** live = sharing (green pulse), waiting = on but no fix / stuck (amber breathing), off = grey, blocked = red; both still. */
export type LiveState = 'live' | 'waiting' | 'off' | 'blocked';

const TONE: Record<LiveState, Tone> = { live: 'success', waiting: 'warn', off: 'idle', blocked: 'danger' };
const DOT = 18;

/**
 * The big tracking indicator on the home screen. One native-driver loop at most (opacity + scale of a single ring),
 * only while the app is on screen and reduce motion is off.
 */
export function StatusPulse({ state, size = 60 }: { state: LiveState; size?: number }) {
  const c = useColors();
  const motion = useMotionAllowed();
  const t = toneColors(c, TONE[state]);
  const pulse = useLoop(motion && state === 'live', 2000, 'pulse');
  const breathe = useLoop(motion && state === 'waiting', 2400, 'breathe');

  const ring =
    state === 'live'
      ? { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }] }
      : state === 'waiting'
        ? { opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.12] }), transform: [{ scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [1.2, 2.2] }) }] }
        : null;

  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size / 2, backgroundColor: t.bg }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {ring ? <Animated.View style={[styles.dot, { backgroundColor: t.dot }, ring]} /> : null}
      <View style={[styles.dot, { backgroundColor: t.dot, borderColor: c.card, borderWidth: 3 }]} />
    </View>
  );
}

/** Small dot that blinks gently while `run` (e.g. next to the live "Location sent …" time). */
export function BlinkDot({ run, color }: { run: boolean; color: string }) {
  const motion = useMotionAllowed();
  const v = useLoop(motion && run, 1800, 'breathe');
  return <Animated.View style={[styles.small, { backgroundColor: color, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.25] }) }]} />;
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  dot: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2 },
  small: { width: 8, height: 8, borderRadius: 4 },
});
