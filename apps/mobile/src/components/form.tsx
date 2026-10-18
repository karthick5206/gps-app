import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Switch, View } from 'react-native';
import { PickerSheet, type PickOption } from '@/components/PickerSheet';
import { SelectField } from '@/components/pickers';
import { Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';

/** Single choice from a list, shown as a field that opens a bottom sheet. */
export function ChoiceField({
  label,
  value,
  options,
  onChange,
  emptyLabel: emptyLabelProp,
  allowEmpty = true,
  error,
}: {
  label: string;
  value: string | null;
  options: PickOption[];
  onChange: (v: string | null) => void;
  emptyLabel?: string;
  allowEmpty?: boolean;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const c = useColors();
  const { t } = useTranslation();
  const emptyLabel = emptyLabelProp ?? t('None');
  const shown = value ? (options.find((o) => o.value === value)?.label ?? '…') : emptyLabel;
  return (
    <View style={{ gap: 4 }}>
      <SelectField label={label} value={shown} onPress={() => setOpen(true)} />
      {error && (
        <Text size="xs" style={{ color: c.destructive }}>
          {error}
        </Text>
      )}
      <PickerSheet
        open={open}
        title={label}
        allLabel={emptyLabel}
        options={options}
        value={value}
        onChange={(v) => (v === null && !allowEmpty ? undefined : onChange(v))}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

export function SwitchRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <View style={[styles.switchRow, { borderColor: c.border }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight="500">{label}</Text>
        {hint && (
          <Text size="xs" tone="muted">
            {hint}
          </Text>
        )}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: c.primary }} />
    </View>
  );
}

export const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());

const styles = StyleSheet.create({
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.sm },
});
