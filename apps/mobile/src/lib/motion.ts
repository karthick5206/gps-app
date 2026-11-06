import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';

/**
 * Motion switches shared by every animation in the app (map marker pulses, blinking live dot, list fade-ins,
 * press feedback): animations stop when the phone's "Reduce motion" / "Remove animations" setting is on and
 * while the app is in the background.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let reduced = false;
let started = false;

function start() {
  if (started) return;
  started = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((v) => set(v))
    .catch(() => undefined);
  AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => set(v));
}

function set(v: boolean) {
  if (v === reduced) return;
  reduced = v;
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  start();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** True when the user asked the phone for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reduced);
}

/** True while the app is in the foreground. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** Decorative motion may run: foreground and reduce motion off. */
export function useMotionAllowed(): boolean {
  const reducedMotion = useReducedMotion();
  const active = useAppActive();
  return active && !reducedMotion;
}
