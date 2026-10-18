import { useMutation } from '@tanstack/react-query';
import {
  PERIOD_REPORT_TYPES,
  POSITIONS_REPORT_MAX_DAYS,
  SINGLE_OBJECT_REPORT_TYPES,
  type ReportFormat,
  type ReportPeriod,
  type ReportRequest,
  type ReportResponse,
  type ReportType,
} from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { FileSpreadsheetIcon, FileTextIcon, PlayIcon, SheetIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { DateField, SelectField, toYmd, VehiclePicker } from '@/components/pickers';
import { Button, Card, Chips, EmptyState, ErrorBanner, Field, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { liveStore } from '@/features/live/live-store';
import { cellText, computeTotals, REPORT_DEF_MAP, type Row } from '@/features/reports/report-defs';
import { daySpan } from '@/features/reports/report-format';
import { api, errorMessage } from '@/lib/api';
import { downloadAndShare } from '@/lib/share-file';
import { SPACE, useColors } from '@/lib/theme';

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
type Preset = 'today' | 'yesterday' | 'last7' | 'month' | 'lastMonth' | 'custom';
function presetDates(p: Exclude<Preset, 'custom'>): [string, string] {
  const now = new Date();
  switch (p) {
    case 'today':
      return [toYmd(now), toYmd(now)];
    case 'yesterday':
      return [toYmd(addDays(now, -1)), toYmd(addDays(now, -1))];
    case 'last7':
      return [toYmd(addDays(now, -7)), toYmd(addDays(now, -1))];
    case 'month':
      return [toYmd(new Date(now.getFullYear(), now.getMonth(), 1)), toYmd(now)];
    case 'lastMonth':
      return [toYmd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), toYmd(new Date(now.getFullYear(), now.getMonth(), 0))];
  }
}

const FORMATS: { format: ReportFormat; label: string; icon: typeof FileTextIcon }[] = [
  { format: 'XLSX', label: 'Excel', icon: FileSpreadsheetIcon },
  { format: 'PDF', label: 'PDF', icon: FileTextIcon },
  { format: 'CSV', label: 'CSV', icon: SheetIcon },
];

/** How many fields a collapsed row card shows. */
const PREVIEW_FIELDS = 5;

function RowCard({ row, columns }: { row: Row; columns: ReturnType<typeof getColumns> }) {
  const [open, setOpen] = useState(false);
  const [title, ...rest] = columns;
  const shown = open ? rest : rest.slice(0, PREVIEW_FIELDS);
  return (
    <Card onPress={rest.length > PREVIEW_FIELDS ? () => setOpen((o) => !o) : undefined}>
      <Text weight="600" numberOfLines={1}>
        {cellText(title, row)}
      </Text>
      <View style={styles.fields}>
        {shown.map((c) => (
          <View key={c.id} style={styles.field}>
            <Text size="xs" tone="muted" numberOfLines={1}>
              {c.header}
            </Text>
            <Text size="sm" weight="500" numberOfLines={open ? undefined : 2}>
              {cellText(c, row)}
            </Text>
          </View>
        ))}
      </View>
      {rest.length > PREVIEW_FIELDS && (
        <Text size="xs" tone="primary" weight="600" style={{ marginTop: SPACE.sm }}>
          {open ? 'Show less' : `Show all ${rest.length + 1} fields`}
        </Text>
      )}
    </Card>
  );
}

const getColumns = (type: ReportType) => REPORT_DEF_MAP[type].columns;

export default function ReportRunScreen() {
  const { type } = useLocalSearchParams<{ type: ReportType }>();
  const def = REPORT_DEF_MAP[type];
  const c = useColors();
  const { can } = useAuth();
  const single = SINGLE_OBJECT_REPORT_TYPES.includes(type);
  const periodic = PERIOD_REPORT_TYPES.includes(type);

  const [preset, setPreset] = useState<Preset>('yesterday');
  const [[from, to], setRange] = useState<[string, string]>(() => presetDates('yesterday'));
  const [period, setPeriod] = useState<ReportPeriod>('DAY');
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [minDuration, setMinDuration] = useState(type === 'HALT' ? '30' : '');
  const [exporting, setExporting] = useState<ReportFormat | null>(null);

  const pickPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetDates(p));
  };

  const request = useMemo<ReportRequest>(
    () => ({
      type,
      scope: { branchIds: [], groupIds: [], objectIds },
      from,
      to,
      ...(periodic ? { period } : {}),
      ...(minDuration && ['HALT', 'STOPS', 'IDLE'].includes(type) ? { options: { minDurationMin: Number(minDuration) } } : {}),
    }),
    [type, objectIds, from, to, periodic, period, minDuration],
  );

  const validation = (() => {
    const span = daySpan(from, to);
    if (!(span >= 1)) return 'The end date must be on or after the start date.';
    if (single && objectIds.length !== 1) return 'Choose one vehicle for this report.';
    if (single && span > POSITIONS_REPORT_MAX_DAYS) return `This report covers at most ${POSITIONS_REPORT_MAX_DAYS} days.`;
    return null;
  })();

  const run = useMutation({
    mutationFn: () => api.post<ReportResponse<Row> & { truncated: boolean; totalRows: number }>('/reports/run', request),
  });
  const exportAs = async (format: ReportFormat) => {
    setExporting(format);
    try {
      await downloadAndShare('/reports/export', { method: 'POST', body: { ...request, format }, fallbackName: `${type.toLowerCase()}-${from}.${format.toLowerCase()}` });
    } catch (err) {
      Alert.alert('Export failed', errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const columns = def?.columns ?? [];
  const rows = run.data?.rows ?? [];
  const totals = useMemo(() => (run.data ? computeTotals(columns, rows, run.data.totals) : {}), [run.data, columns, rows]);
  const totalCols = columns.filter((col) => totals[col.id] !== undefined);

  if (!def) return <EmptyState icon={FileTextIcon} title="Unknown report" />;
  const vehicleLabel = objectIds.length === 0 ? (single ? 'Choose a vehicle' : 'All vehicles') : objectIds.length === 1 ? (liveStore.get(objectIds[0])?.name ?? '1 vehicle') : `${objectIds.length} vehicles`;

  return (
    <>
      <Stack.Screen options={{ title: def.label }} />
      <FlatList
        data={rows}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm }}
        initialNumToRender={15}
        ListHeaderComponent={
          <View style={{ gap: SPACE.md, marginBottom: SPACE.sm }}>
            <Text size="sm" tone="muted">
              {def.description}
            </Text>
            <SelectField label={single ? 'Vehicle' : 'Vehicles'} value={vehicleLabel} onPress={() => setPicker(true)} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Chips
                value={preset}
                onChange={pickPreset}
                options={[
                  { value: 'today', label: 'Today' },
                  { value: 'yesterday', label: 'Yesterday' },
                  { value: 'last7', label: 'Last 7 days' },
                  { value: 'month', label: 'This month' },
                  { value: 'lastMonth', label: 'Last month' },
                  { value: 'custom', label: 'Custom' },
                ]}
              />
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              <DateField label="From" value={from} maximumDate={new Date()} onChange={(v) => (setPreset('custom'), setRange([v, to]))} />
              <DateField label="To" value={to} maximumDate={new Date()} onChange={(v) => (setPreset('custom'), setRange([from, v]))} />
            </View>
            {periodic && (
              <Chips
                value={period}
                onChange={setPeriod}
                options={[
                  { value: 'DAY', label: 'Daily' },
                  { value: 'WEEK', label: 'Weekly' },
                  { value: 'MONTH', label: 'Monthly' },
                ]}
              />
            )}
            {['HALT', 'STOPS', 'IDLE'].includes(type) && (
              <Field label="Minimum duration (min)" value={minDuration} onChangeText={(v) => setMinDuration(v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="Any" />
            )}
            {validation && (
              <Text size="sm" tone="destructive">
                {validation}
              </Text>
            )}
            <Button title="Run report" icon={PlayIcon} onPress={() => run.mutate()} loading={run.isPending} disabled={!!validation} />
            {can('reports', 'export') && (
              <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
                {FORMATS.map((f) => (
                  <Button key={f.format} title={f.label} icon={f.icon} variant="outline" style={{ flex: 1, paddingHorizontal: SPACE.sm }} loading={exporting === f.format} disabled={!!validation || !!exporting} onPress={() => exportAs(f.format)} />
                ))}
              </View>
            )}
            {run.isError && <ErrorBanner message={errorMessage(run.error)} />}
            {run.data && (
              <>
                <Text size="sm" tone="muted">
                  {run.data.totalRows.toLocaleString()} rows{run.data.truncated ? ` (showing the first ${rows.length.toLocaleString()} — export for all)` : ''}
                </Text>
                {totalCols.length > 0 && rows.length > 0 && (
                  <Card style={{ backgroundColor: c.accent }}>
                    <Text weight="600">Totals</Text>
                    <View style={styles.fields}>
                      {totalCols.map((col) => (
                        <View key={col.id} style={styles.field}>
                          <Text size="xs" tone="muted">
                            {col.header}
                          </Text>
                          <Text size="sm" weight="600">
                            {col.format ? col.format(totals[col.id]) : totals[col.id].toLocaleString()}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </Card>
                )}
              </>
            )}
          </View>
        }
        renderItem={({ item }) => <RowCard row={item} columns={columns} />}
        ListEmptyComponent={run.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : run.data ? <EmptyState icon={def.icon} title="No data" description="Nothing matched for these vehicles and dates." /> : undefined}
      />
      <VehiclePicker open={picker} onClose={() => setPicker(false)} selected={objectIds} onChange={setObjectIds} multiple={!single} title={single ? 'Choose a vehicle' : 'Choose vehicles'} />
    </>
  );
}

const styles = StyleSheet.create({
  fields: { flexDirection: 'row', flexWrap: 'wrap', marginTop: SPACE.sm, rowGap: SPACE.sm },
  field: { width: '50%', paddingRight: SPACE.sm, gap: 1 },
});
