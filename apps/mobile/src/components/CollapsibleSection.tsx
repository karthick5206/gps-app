import * as SecureStore from 'expo-secure-store';
import { ChevronDownIcon } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';

const KEY = (id: string) => `vt.section.${id.replace(/[^\w.-]/g, '_')}`;

/**
 * Remembered open / closed state of a screen section or panel (kept on the phone, per section id). Starts at
 * `initial` until the saved choice has loaded.
 */
export function useRememberedToggle(id: string, initial: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(initial);
  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(KEY(id))
      .then((v) => alive && v !== null && setOpen(v === '1'))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      void SecureStore.setItemAsync(KEY(id), next ? '1' : '0').catch(() => undefined);
      return next;
    });
  return [open, toggle];
}

/** Section title that opens / closes its content (tap the title); the choice is remembered on the phone. */
export function CollapsibleSection({
  id,
  title,
  summary,
  initialOpen = true,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const c = useColors();
  const [open, toggle] = useRememberedToggle(id, initialOpen);
  return (
    <View style={{ gap: SPACE.sm }}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        hitSlop={6}
        style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingTop: SPACE.sm }}
      >
        <Text size="xs" weight="700" tone="muted" style={{ letterSpacing: 0.8, textTransform: 'uppercase', flex: 1 }}>
          {title}
        </Text>
        {!open && summary ? (
          <Text size="xs" tone="muted" numberOfLines={1} style={{ maxWidth: '55%' }}>
            {summary}
          </Text>
        ) : null}
        <ChevronDownIcon size={18} color={c.mutedForeground} style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }} />
      </Pressable>
      {open ? children : null}
    </View>
  );
}
