import { CheckIcon } from 'lucide-react-native';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

export interface PickOption {
  value: string;
  label: string;
}

/** Single-choice list in a bottom modal ("All …" first). */
export function PickerSheet({
  open,
  title,
  allLabel,
  options,
  value,
  onChange,
  onClose,
}: {
  open: boolean;
  title: string;
  allLabel: string;
  options: PickOption[];
  value: string | null;
  onChange: (v: string | null) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const rows: { value: string | null; label: string }[] = [{ value: null, label: allLabel }, ...options];
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: c.card }]}>
        <View style={[styles.handle, { backgroundColor: c.border }]} />
        <Text weight="700" style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
          {title}
        </Text>
        <FlatList
          data={rows}
          keyExtractor={(r) => r.value ?? '__all'}
          style={{ maxHeight: 420 }}
          renderItem={({ item }) => {
            const on = item.value === value;
            return (
              <Pressable
                onPress={() => {
                  onChange(item.value);
                  onClose();
                }}
                style={({ pressed }) => [styles.row, { borderTopColor: c.border }, pressed && { backgroundColor: c.muted }]}
              >
                <Text style={{ flex: 1 }} weight={on ? '600' : '400'} tone={on ? 'primary' : 'default'}>
                  {item.label}
                </Text>
                {on && <CheckIcon size={18} color={c.primary} />}
              </Pressable>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#0006' },
  sheet: { borderTopLeftRadius: RADIUS.lg, borderTopRightRadius: RADIUS.lg, paddingTop: SPACE.sm },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.lg, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
