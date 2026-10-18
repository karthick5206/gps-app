import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useColors } from '@/lib/theme';

/**
 * Horizontal seek bar (tap or drag). Pure JS on PanResponder, so it adds no native code
 * (native slider libraries push the Android C++ build past Windows' path-length limit).
 */
export function SeekBar({ min, max, value, onSeek }: { min: number; max: number; value: number; onSeek: (v: number) => void }) {
  const c = useColors();
  const width = useRef(0);
  const [drag, setDrag] = useState<number | null>(null);
  const range = Math.max(1, max - min);
  const toValue = (x: number) => min + Math.min(1, Math.max(0, x / Math.max(1, width.current))) * range;
  const latest = useRef({ toValue, onSeek });
  latest.current = { toValue, onSeek };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => setDrag(latest.current.toValue(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setDrag(latest.current.toValue(e.nativeEvent.locationX)),
        onPanResponderRelease: (e) => {
          latest.current.onSeek(latest.current.toValue(e.nativeEvent.locationX));
          setDrag(null);
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    [],
  );

  const shown = drag ?? value;
  const pct = `${(Math.min(1, Math.max(0, (shown - min) / range)) * 100).toFixed(2)}%` as const;
  return (
    <View
      {...responder.panHandlers}
      onLayout={(e: LayoutChangeEvent) => (width.current = e.nativeEvent.layout.width)}
      style={styles.hit}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(((shown - min) / range) * 100) }}
    >
      <View pointerEvents="none" style={[styles.track, { backgroundColor: c.border }]}>
        <View style={{ width: pct, height: '100%', borderRadius: 2, backgroundColor: c.primary }} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left: pct, backgroundColor: c.primary, borderColor: c.card }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 36, justifyContent: 'center', marginHorizontal: 12 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  thumb: { position: 'absolute', width: 18, height: 18, borderRadius: 9, marginLeft: -9, borderWidth: 2, top: 9 },
});
