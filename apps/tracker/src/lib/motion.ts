import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing } from 'react-native';

/**
 * True when decorative motion may run: the phone's "Remove animations" / reduce motion is off and the app is on
 * screen. Every looping animation goes through this, so nothing animates in the background (this app runs all day).
 */
export function useMotionAllowed(): boolean {
  const [reduced, setReduced] = useState(true); // still until we know
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => live && setReduced(r))
      .catch(() => live && setReduced(false));
    const a11y = AccessibilityInfo.addEventListener('reduceMotionChanged', (r) => setReduced(r));
    const app = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => {
      live = false;
      a11y.remove();
      app.remove();
    };
  }, []);
  return !reduced && active;
}

/**
 * A 0 → 1 value that loops while `run` is true, on the native driver (opacity / transform only).
 * 'pulse': 0 → 1 then restarts (an expanding ring). 'breathe': 0 → 1 → 0 (a slow swell or a blink).
 * Stopped and reset to 0 as soon as `run` turns false.
 */
export function useLoop(run: boolean, durationMs: number, kind: 'pulse' | 'breathe' = 'pulse'): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) {
      v.stopAnimation();
      v.setValue(0);
      return;
    }
    const anim =
      kind === 'pulse'
        ? Animated.loop(Animated.timing(v, { toValue: 1, duration: durationMs, easing: Easing.out(Easing.quad), useNativeDriver: true }))
        : Animated.loop(
            Animated.sequence([
              Animated.timing(v, { toValue: 1, duration: durationMs / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
              Animated.timing(v, { toValue: 0, duration: durationMs / 2, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            ]),
          );
    anim.start();
    return () => {
      anim.stop();
      v.setValue(0);
    };
  }, [run, durationMs, kind, v]);
  return v;
}
