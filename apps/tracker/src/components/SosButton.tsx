import * as Location from 'expo-location';
import { useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { Tracker } from '@/lib/tracking';

const HOLD_MS = 2000;
const SIZE = 150;

/** SOS needs at least foreground location permission (ask if missing). */
async function ensureLocationPermission(): Promise<boolean> {
  let perm = await Location.getForegroundPermissionsAsync();
  if (!perm.granted) perm = await Location.requestForegroundPermissionsAsync();
  return perm.granted;
}

const RESULT: Record<string, { text: string; ok: boolean }> = {
  sent: { text: S.sosSent, ok: true },
  queued: { text: S.sosQueued, ok: false },
  rejected: { text: S.sosRejected, ok: false },
  stopped: { text: S.sosStopped, ok: false },
  no_location: { text: S.sosNoLocation, ok: false },
};

/**
 * Large red SOS button: press and hold for 2 s. The native engine takes a fresh fix (up to 15 s, else the last
 * known one), queues it with sos=true and sends it alone at once (kept in the queue if offline).
 */
export function SosButton({ onDone }: { onDone?: () => void }) {
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
      if (!(await ensureLocationPermission())) return setResult(RESULT.no_location);
      const r = await Tracker.sendSos().catch(() => 'queued');
      setResult(RESULT[r] ?? RESULT.no_location);
    } finally {
      setState('idle');
      progress.setValue(0);
      onDone?.();
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
