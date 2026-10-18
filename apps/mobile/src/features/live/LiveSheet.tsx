import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { RADIUS, useColors } from '@/lib/theme';

export type SheetSnap = 'peek' | 'half' | 'full';

/**
 * Draggable bottom sheet over the map (pure JS: Animated + PanResponder, no native modules).
 * Drag the header to move between peek (header only), half and full height; flicks follow the velocity.
 */
export function LiveSheet({
  containerHeight,
  topInset,
  snap,
  onSnapChange,
  header,
  children,
}: {
  containerHeight: number;
  topInset: number;
  snap: SheetSnap;
  onSnapChange: (s: SheetSnap) => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const [headerHeight, setHeaderHeight] = useState(240);
  const positions = useMemo(() => {
    const full = topInset + 8;
    const peek = Math.max(full, containerHeight - headerHeight);
    const half = Math.min(peek, Math.max(full, containerHeight * 0.42));
    return { full, half, peek };
  }, [containerHeight, headerHeight, topInset]);

  const y = useRef(new Animated.Value(positions.peek)).current;
  const current = useRef(positions.peek);
  const latest = useRef({ positions, onSnapChange });
  latest.current = { positions, onSnapChange };

  const animateTo = (target: number) => {
    current.current = target;
    Animated.spring(y, { toValue: target, useNativeDriver: true, bounciness: 2, speed: 16 }).start();
  };

  useEffect(() => {
    animateTo(positions[snap]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, positions]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => y.stopAnimation((v) => (current.current = v)),
        onPanResponderMove: (_e, g) => {
          const p = latest.current.positions;
          y.setValue(Math.min(p.peek + 40, Math.max(p.full, current.current + g.dy)));
        },
        onPanResponderRelease: (_e, g) => {
          const p = latest.current.positions;
          const at = Math.min(p.peek, Math.max(p.full, current.current + g.dy));
          const projected = at + g.vy * 220;
          const entries = Object.entries(p) as [SheetSnap, number][];
          const [nearest] = entries.reduce((best, e) => (Math.abs(e[1] - projected) < Math.abs(best[1] - projected) ? e : best));
          animateTo(p[nearest]);
          latest.current.onSnapChange(nearest);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <Animated.View
      style={[
        styles.sheet,
        { backgroundColor: c.card, borderColor: c.border, height: Math.max(0, containerHeight - positions.full), transform: [{ translateY: y }] },
      ]}
    >
      <View {...pan.panHandlers} onLayout={(e: LayoutChangeEvent) => setHeaderHeight(Math.round(e.nativeEvent.layout.height))}>
        <View style={[styles.handle, { backgroundColor: c.border }]} />
        {header}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    borderTopLeftRadius: RADIUS.lg + 4,
    borderTopRightRadius: RADIUS.lg + 4,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: 8, marginBottom: 10 },
});
