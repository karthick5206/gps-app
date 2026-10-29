import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import type { LiveObject } from '@veetracer/shared';
import { CalendarIcon, CheckIcon, ChevronDownIcon, ClockIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, SearchInput, Text } from '@/components/ui';
import { VehicleThumb } from '@/features/live/components';
import { liveStore } from '@/features/live/live-store';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

/** Tappable field that shows a value and opens something (picker, sheet). */
export function SelectField({ label, value, onPress, icon: Icon = ChevronDownIcon }: { label: string; value: string; onPress: () => void; icon?: typeof ChevronDownIcon }) {
  const c = useColors();
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <Text size="sm" weight="500">
        {label}
      </Text>
      <Pressable onPress={onPress} style={[styles.field, { borderColor: c.border, backgroundColor: c.card }]} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
        <Text numberOfLines={1} style={{ flex: 1 }}>
          {value}
        </Text>
        <Icon size={18} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Date (YYYY-MM-DD) field using the platform date picker. */
export function DateField({ label, value, onChange, minimumDate, maximumDate }: { label: string; value: string; onChange: (v: string) => void; minimumDate?: Date; maximumDate?: Date }) {
  const [iosOpen, setIosOpen] = useState(false);
  const date = fromYmd(value);
  const open = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({ value: date, mode: 'date', minimumDate, maximumDate, onChange: (e, d) => e.type === 'set' && d && onChange(toYmd(d)) });
    } else setIosOpen((o) => !o);
  };
  return (
    <View style={{ flex: 1, gap: SPACE.sm }}>
      <SelectField label={label} value={date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })} onPress={open} icon={CalendarIcon} />
      {iosOpen && Platform.OS === 'ios' && (
        <DateTimePicker value={date} mode="date" display="inline" minimumDate={minimumDate} maximumDate={maximumDate} onChange={(_, d) => d && onChange(toYmd(d))} />
      )}
    </View>
  );
}

/** Time of day as minutes after midnight (0–1439), using the platform time picker. */
export function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (minutes: number) => void }) {
  const [iosOpen, setIosOpen] = useState(false);
  const date = new Date(2000, 0, 1, Math.floor(value / 60), value % 60);
  const set = (d: Date | undefined) => d && onChange(d.getHours() * 60 + d.getMinutes());
  const open = () => {
    if (Platform.OS === 'android') DateTimePickerAndroid.open({ value: date, mode: 'time', is24Hour: true, onChange: (e, d) => e.type === 'set' && set(d) });
    else setIosOpen((o) => !o);
  };
  return (
    <View style={{ flex: 1, gap: SPACE.sm }}>
      <SelectField label={label} value={`${pad(Math.floor(value / 60))}:${pad(value % 60)}`} onPress={open} icon={ClockIcon} />
      {iosOpen && Platform.OS === 'ios' && <DateTimePicker value={date} mode="time" display="spinner" onChange={(_, d) => set(d)} />}
    </View>
  );
}

/** Full-screen vehicle chooser (single or multiple) over the live fleet list. */
export function VehiclePicker({
  open,
  onClose,
  selected,
  onChange,
  multiple = true,
  title: titleProp,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  title?: string;
}) {
  const c = useColors();
  const { t } = useTranslation();
  const title = titleProp ?? t('Choose vehicles');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const all = useMemo(() => (open ? [...liveStore.all()].sort((a, b) => a.name.localeCompare(b.name)) : []), [open]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? all.filter((o) => `${o.name} ${o.plateNumber ?? ''} ${o.uniqueId ?? ''}`.toLowerCase().includes(s)) : all;
  }, [all, q]);

  const toggle = (o: LiveObject) => {
    if (!multiple) {
      onChange([o.objectId]);
      onClose();
      return;
    }
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(o.objectId)) n.delete(o.objectId);
      else n.add(o.objectId);
      return n;
    });
  };

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose} onShow={() => setPicked(new Set(selected))}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text tone="primary" weight="600">
              {t('Cancel')}
            </Text>
          </Pressable>
          <Text weight="700">{title}</Text>
          {multiple ? (
            <Pressable onPress={() => setPicked(new Set())} hitSlop={10}>
              <Text tone="primary" weight="600">
                {t('Clear')}
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: 44 }} />
          )}
        </View>
        <View style={{ padding: SPACE.md }}>
          <SearchInput value={q} onChangeText={setQ} placeholder={t('Search vehicle, plate or IMEI')} />
        </View>
        <FlatList
          data={rows}
          keyExtractor={(o) => o.objectId}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const on = multiple ? picked.has(item.objectId) : selected.includes(item.objectId);
            return (
              <Pressable onPress={() => toggle(item)} style={[styles.row, { borderBottomColor: c.border }]}>
                <VehicleThumb o={item} size={28} />
                <View style={{ flex: 1 }}>
                  <Text weight="500">{item.name}</Text>
                  {item.plateNumber && item.plateNumber !== item.name && (
                    <Text size="sm" tone="muted">
                      {item.plateNumber}
                    </Text>
                  )}
                </View>
                <View style={[styles.check, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary : 'transparent' }]}>{on && <CheckIcon size={14} color={c.primaryForeground} />}</View>
              </Pressable>
            );
          }}
        />
        {multiple && (
          <View style={{ padding: SPACE.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }}>
            <Button
              title={picked.size ? (picked.size === 1 ? t('Use 1 vehicle') : t('Use {{count}} vehicles', { count: picked.size })) : t('Use all vehicles')}
              onPress={() => {
                onChange([...picked]);
                onClose();
              }}
            />
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  field: { height: 46, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
