import * as Location from 'expo-location';
import { useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { readBattery, toPoint } from '@/lib/points';
import { store } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { sendSos } from '@/lib/uploader';

const HOLD_MS = 2000;
const SIZE = 150;

/** Current location for SOS: a fresh fix (up to 15 s), else the last known one. */
async function sosLocation(): Promise<Location.LocationObject | null> {
  let perm = await Location.getForegroundPermissionsAsync();
  if (!perm.granted) perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return null;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15_000));
  const fresh = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null), timeout]);
  return fresh ?? (await Location.getLastKnownPositionAsync().catch(() => null));
}

/** Large red SOS button: press and hold for 2 s to send one SOS point with the current location. */
export function SosButton() {
  const c = useColors();
  const progress = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<'idle' | 'sending'>('idle');
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  const fire = async () => {
    setState('sending');
    setResult(null);
    Vibration.vibrate(300);
    try {
      const loc = await sosLocation();
      if (!loc) return setResult({ text: S.sosNoLocation, ok: false });
      // Keep the fix time, but never reuse the time of a point already queued / sent (the server dedupes on it).
      const p = toPoint(loc, await readBattery(), true);
      const point = { ...p, t: Math.max(p.t, store.lastT() + 1) };
      store.setLastT(point.t);
      const sent = await sendSos(point);
      setResult(sent ? { text: S.sosSent, ok: true } : { text: S.sosQueued, ok: false });
    } finally {
      setState('idle');
      progress.setValue(0);
    }
  };

  const pressIn = () => {
    if (state === 'sending') return;
    Animated.timing(progress, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false }).start();
    timer.current = setTimeout(() => {
      timer.current = null;
      fire();
    }, HOLD_MS);
  };

  const pressOut = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  const fill = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${S.sos}. ${S.sosHint}`}
        onPressIn={pressIn}
        onPressOut={pressOut}
        style={[styles.button, { backgroundColor: c.danger }]}
      >
        <Animated.View style={[styles.fill, { height: fill }]} />
        <Text style={styles.label}>{state === 'sending' ? '…' : S.sos}</Text>
      </Pressable>
      <Text style={[styles.hint, { color: c.muted }]}>{state === 'sending' ? S.sosSending : S.sosHint}</Text>
      {result ? (
        <Text style={[styles.result, { color: result.ok ? c.success : c.danger }]}>{result.text}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    elevation: 6,
    borderWidth: 6,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  fill: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.28)' },
  label: { color: '#ffffff', fontSize: 40, fontWeight: '900', letterSpacing: 2 },
  hint: { fontSize: 14 },
  result: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
