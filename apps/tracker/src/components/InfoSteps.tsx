import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/lib/theme';

const STEP_MS = 2600;

/** "How it works" steps on the first page; the current one is highlighted in turn (still with reduce motion). */
export function InfoSteps({ steps }: { steps: readonly string[] }) {
  const c = useColors();
  const [active, setActive] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => {
        if (!mounted || reduced) return;
        timer = setInterval(() => {
          fade.setValue(0.35);
          Animated.timing(fade, { toValue: 1, duration: 450, useNativeDriver: true }).start();
          setActive((a) => (a + 1) % steps.length);
        }, STEP_MS);
      });
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [steps.length, fade]);
  return (
    <View style={styles.list}>
      {steps.map((s, i) => {
        const on = i === active;
        return (
          <Animated.View key={s} style={[styles.row, { opacity: on ? fade : 0.75 }]}>
            <View style={[styles.num, { backgroundColor: on ? c.primary : c.primarySoft }]}>
              <Text style={[styles.numText, { color: on ? '#fff' : c.primary }]}>{i + 1}</Text>
            </View>
            <Text style={[styles.text, { color: c.text, fontWeight: on ? '700' : '500' }]}>{s}</Text>
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 14, fontWeight: '800' },
  text: { flex: 1, fontSize: 15 },
});
