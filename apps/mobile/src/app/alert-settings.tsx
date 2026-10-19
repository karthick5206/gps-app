import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  DEFAULT_CHANNELS,
  type ChannelsBySeverity,
  type NotifyChannel,
  type AlertSeverity,
  type AlertSettingDto,
  type AlertTypeDef,
  type EffectiveAlertSetting,
} from '@veetracer/shared';
import { Stack } from 'expo-router';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, LockIcon, RotateCcwIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SelectField, VehiclePicker } from '@/components/pickers';
import { Button, Card, Chips, ErrorBanner, Text } from '@/components/ui';
import { AlertTypeIcon, SEVERITY_COLOR, SEVERITY_LABEL } from '@/features/alerts/alert-icons';
import { RecipientsCard } from '@/features/alerts/RecipientsCard';
import { useAuth } from '@/features/auth/auth';
import { liveStore } from '@/features/live/live-store';
import { api, errorMessage } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

type Level = 'COMPANY' | 'OBJECT';
/** Channels offered in the app (WhatsApp is not configured on the server yet). */
const CHANNELS: { key: NotifyChannel; label: string }[] = [
  { key: 'INAPP', label: 'In-app' },
  { key: 'EMAIL', label: 'Email' },
  { key: 'SMS', label: 'SMS' },
  { key: 'PUSH', label: 'Push' },
];
const sameSet = (a: NotifyChannel[], b: NotifyChannel[]) => a.length === b.length && a.every((x) => b.includes(x));
const CATEGORY_ORDER: AlertTypeDef['category'][] = ['Driving', 'Driver safety', 'Vehicle', 'Location', 'Safety', 'Device', 'Device health', 'Compliance'];

/** What one alert type looks like at the chosen level: values, and whether this level overrides them. */
interface Row {
  def: AlertTypeDef;
  enabled: boolean;
  severity: AlertSeverity;
  params: Record<string, unknown>;
  channels: ChannelsBySeverity;
  supported: boolean;
  /** Override stored at this level (null = all inherited). */
  own: AlertSettingDto | null;
}

function ParamInput({ def, value, onChange }: { def: AlertTypeDef['params'][number]; value: string; onChange: (v: string) => void }) {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <View style={{ gap: 4, width: '48%' }}>
      <Text size="xs" tone="muted" numberOfLines={2}>
        {t(def.label)}
        {def.unit ? ` (${t(def.unit)})` : ''}
      </Text>
      <TextInput
        value={value}
        onChangeText={(v) => onChange(def.type === 'number' ? v.replace(/[^\d.]/g, '') : v)}
        keyboardType={def.type === 'number' ? 'decimal-pad' : 'numbers-and-punctuation'}
        placeholder={def.type === 'time' ? 'HH:MM' : def.default === null ? t('Not set') : String(def.default)}
        placeholderTextColor={c.mutedForeground}
        style={[styles.input, { borderColor: c.border, color: c.foreground, backgroundColor: c.background }]}
      />
    </View>
  );
}

function AlertTypeCard({ row, level, targetId, canEdit, onSaved }: { row: Row; level: Level; targetId: string; canEdit: boolean; onSaved: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const { def } = row;
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<AlertSeverity>(row.severity);
  const [channels, setChannels] = useState<ChannelsBySeverity>(row.channels);
  const toggleChannel = (sev: AlertSeverity, ch: NotifyChannel) =>
    setChannels((cur) => ({ ...cur, [sev]: cur[sev].includes(ch) ? cur[sev].filter((x) => x !== ch) : [...cur[sev], ch] }));
  const editable = def.params.filter((p) => p.type === 'number' || p.type === 'time');
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((p) => [p.key, row.params[p.key] == null ? '' : String(row.params[p.key])])));

  const put = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AlertSettingDto>('/alert-settings', { level, targetId, alertType: def.code, ...body }),
    onSuccess: onSaved,
    onError: (err) => Alert.alert(t('Not saved'), errorMessage(err)),
  });

  const toggle = (enabled: boolean) => put.mutate({ enabled });
  const save = () => {
    const params: Record<string, unknown> = {};
    for (const p of editable) {
      const raw = values[p.key]?.trim() ?? '';
      const before = row.params[p.key] == null ? '' : String(row.params[p.key]);
      if (raw === before) continue;
      if (p.type === 'number') {
        const n = raw === '' ? null : Number(raw);
        if (n !== null && (!Number.isFinite(n) || (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max))) {
          Alert.alert(t('Check the value'), `${t(p.label)}: ${p.min ?? 0} – ${p.max ?? '∞'} ${p.unit ? t(p.unit) : ''}`);
          return;
        }
        params[p.key] = n;
      } else {
        if (raw && !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
          Alert.alert(t('Check the value'), `${t(p.label)}: ${t('use HH:MM, e.g. 22:00')}`);
          return;
        }
        params[p.key] = raw || null;
      }
    }
    const body: Record<string, unknown> = {};
    if (Object.keys(params).length) body.params = params;
    if (severity !== row.severity) body.severity = severity;
    const changedChannels = ALERT_SEVERITIES.filter((sev) => !sameSet(channels[sev], row.channels[sev]));
    if (changedChannels.length) body.channels = Object.fromEntries(changedChannels.map((sev) => [sev, channels[sev]]));
    if (!Object.keys(body).length) return setOpen(false);
    put.mutate(body, { onSuccess: () => setOpen(false) });
  };
  const reset = () =>
    Alert.alert(
      t('Use inherited settings?'),
      level === 'OBJECT' ? t('{{name}} goes back to the company / group settings.', { name: t(def.label) }) : t('{{name}} goes back to the default settings.', { name: t(def.label) }),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Reset'), style: 'destructive', onPress: () => put.mutate({ enabled: null, severity: null, params: null, channels: null }) },
      ],
    );

  const lockOff = def.mandatory && level === 'OBJECT';
  return (
    <Card style={!row.supported ? { opacity: 0.6 } : undefined}>
      <Pressable onPress={() => setOpen((o) => !o)} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
        <AlertTypeIcon type={def.code} severity={row.severity} size={32} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text weight="600">{t(def.label)}</Text>
            {def.mandatory && <LockIcon size={13} color={c.mutedForeground} />}
          </View>
          <Text size="xs" tone="muted">
            {!row.supported ? t('Not supported by this tracker') : `${t(SEVERITY_LABEL[row.severity])}${row.own ? ` · ${t('customised here')}` : ''}`}
          </Text>
        </View>
        {put.isPending ? (
          <ActivityIndicator />
        ) : (
          <Switch value={row.enabled} onValueChange={toggle} disabled={!canEdit || !row.supported || (lockOff && row.enabled)} trackColor={{ true: c.primary }} />
        )}
        {open ? <ChevronUpIcon size={18} color={c.mutedForeground} /> : <ChevronDownIcon size={18} color={c.mutedForeground} />}
      </Pressable>

      {open && (
        <View style={{ gap: SPACE.md, marginTop: SPACE.md }}>
          <View style={{ gap: 6 }}>
            <Text size="xs" tone="muted">
              {t('Severity')}
            </Text>
            <Chips value={severity} onChange={setSeverity} options={ALERT_SEVERITIES.map((s) => ({ value: s, label: t(SEVERITY_LABEL[s]), color: SEVERITY_COLOR[s] }))} />
          </View>
          {editable.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: SPACE.md }}>
              {editable.map((p) => (
                <ParamInput key={p.key} def={p} value={values[p.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [p.key]: v }))} />
              ))}
            </View>
          )}
          <View style={{ gap: 6 }}>
            <Text size="xs" tone="muted">
              {t('Notify by')}
            </Text>
            <View style={styles.grid}>
              <View style={styles.gridRow}>
                <View style={styles.gridLabel} />
                {CHANNELS.map((ch) => (
                  <Text key={ch.key} size="xs" tone="muted" style={styles.gridCell}>
                    {t(ch.label)}
                  </Text>
                ))}
              </View>
              {ALERT_SEVERITIES.map((sev) => (
                <View key={sev} style={styles.gridRow}>
                  <Text size="sm" style={[styles.gridLabel, { color: SEVERITY_COLOR[sev] }]} weight={sev === severity ? '700' : '400'}>
                    {t(SEVERITY_LABEL[sev])}
                  </Text>
                  {CHANNELS.map((ch) => {
                    const on = channels[sev].includes(ch.key);
                    return (
                      <Pressable
                        key={ch.key}
                        disabled={!canEdit}
                        onPress={() => toggleChannel(sev, ch.key)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={t('{{severity}} by {{channel}}', { severity: t(SEVERITY_LABEL[sev]), channel: t(ch.label) })}
                        style={styles.gridCell}
                      >
                        <View style={[styles.box, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary : 'transparent' }]}>
                          {on && <CheckIcon size={13} color={c.primaryForeground} />}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
            <Text size="xs" tone="muted">
              {t('The row matching this alert’s severity is used. Email / SMS go to the default recipients plus the extra ones above.')}
            </Text>
          </View>
          {def.params.some((p) => p.type === 'geofences') && (
            <Text size="xs" tone="muted">
              {t('Geofence exclusions are edited in the web app.')}
            </Text>
          )}
          {canEdit && (
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              {row.own && <Button title={t('Reset')} icon={RotateCcwIcon} variant="outline" onPress={reset} style={{ flex: 1 }} />}
              <Button title={t('Save')} onPress={save} loading={put.isPending} style={{ flex: 1 }} />
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

export default function AlertSettingsScreen() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can('alert_settings', 'edit') || can('alert_settings', 'create');
  const [level, setLevel] = useState<Level>('COMPANY');
  const [objectId, setObjectId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const companyId = me?.company.id ?? '';
  const targetId = level === 'COMPANY' ? companyId : objectId;

  const overrides = useQuery({
    queryKey: ['alert-settings', level, targetId],
    queryFn: ({ signal }) => api.get<AlertSettingDto[]>('/alert-settings', { level, targetId }, signal),
    enabled: !!targetId,
  });
  const effective = useQuery({
    queryKey: ['alert-settings', 'effective', objectId],
    queryFn: ({ signal }) => api.get<EffectiveAlertSetting[]>('/alert-settings/effective', { objectId }, signal),
    enabled: level === 'OBJECT' && !!objectId,
  });

  const rows = useMemo<Row[]>(() => {
    const own = new Map((overrides.data ?? []).map((o) => [o.alertType, o]));
    const eff = new Map((effective.data ?? []).map((e) => [e.alertType, e]));
    return ALERT_TYPES.map((def) => {
      const o = own.get(def.code) ?? null;
      const e = eff.get(def.code);
      const defaults = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
      if (level === 'OBJECT' && e) return { def, enabled: e.enabled, severity: e.severity, params: e.params, channels: e.channels, supported: e.supported, own: o };
      const channels = Object.fromEntries(ALERT_SEVERITIES.map((sev) => [sev, [...(o?.channels?.[sev] ?? DEFAULT_CHANNELS[sev])]])) as ChannelsBySeverity;
      return { def, enabled: o?.enabled ?? def.defaultEnabled, severity: o?.severity ?? def.defaultSeverity, params: { ...defaults, ...(o?.params ?? {}) }, channels, supported: true, own: o };
    }).sort((a, b) => CATEGORY_ORDER.indexOf(a.def.category) - CATEGORY_ORDER.indexOf(b.def.category));
  }, [overrides.data, effective.data, level]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['alert-settings'] });
  const loading = !!targetId && (overrides.isPending || (level === 'OBJECT' && effective.isPending));
  const error = overrides.error ?? effective.error;
  const vehicleName = objectId ? (liveStore.get(objectId)?.name ?? t('Vehicle')) : t('Choose a vehicle');

  return (
    <>
      <Stack.Screen options={{ title: t('Alert settings') }} />
      <FlatList
        data={targetId ? rows : []}
        keyExtractor={(r) => `${level}-${targetId}-${r.def.code}-${r.own?.updatedAt ?? ''}`}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm }}
        ListHeaderComponent={
          <View style={{ gap: SPACE.md, marginBottom: SPACE.sm }}>
            <Chips
              value={level}
              onChange={setLevel}
              options={[
                { value: 'COMPANY', label: t('Whole company') },
                { value: 'OBJECT', label: t('One vehicle') },
              ]}
            />
            {level === 'OBJECT' && <SelectField label={t('Vehicle')} value={vehicleName} onPress={() => setPicker(true)} />}
            <Text size="sm" tone="muted">
              {level === 'COMPANY'
                ? t('Applies to every vehicle unless a group or vehicle has its own setting.')
                : t('Changes here apply only to this vehicle and override company and group settings.')}
            </Text>
            {!canEdit && (
              <Text size="sm" tone="muted">
                {t('You can view these settings; ask an admin to change them.')}
              </Text>
            )}
            {targetId && <RecipientsCard key={`${level}-${targetId}`} level={level} targetId={targetId} canEdit={canEdit} />}
            {error && <ErrorBanner message={errorMessage(error)} onRetry={() => void refresh()} />}
            {loading && <ActivityIndicator style={{ margin: SPACE.lg }} />}
          </View>
        }
        renderItem={({ item, index }) => (
          <View style={{ gap: SPACE.sm }}>
            {(index === 0 || rows[index - 1].def.category !== item.def.category) && (
              <Text size="xs" tone="muted" weight="600" style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginTop: index ? SPACE.md : 0 }}>
                {t(item.def.category)}
              </Text>
            )}
            <AlertTypeCard row={item} level={level} targetId={targetId!} canEdit={canEdit} onSaved={refresh} />
          </View>
        )}
      />
      <VehiclePicker open={picker} onClose={() => setPicker(false)} selected={objectId ? [objectId] : []} onChange={(ids) => setObjectId(ids[0] ?? null)} multiple={false} title={t('Choose a vehicle')} />
    </>
  );
}

const styles = StyleSheet.create({
  input: { height: 42, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, fontSize: 15 },
  grid: { gap: 6 },
  gridRow: { flexDirection: 'row', alignItems: 'center' },
  gridLabel: { width: 72 },
  gridCell: { flex: 1, alignItems: 'center', textAlign: 'center' },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});

