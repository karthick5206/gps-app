import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMAND_DEF_MAP, ENGINE_STOP_MAX_SPEED_KPH, type AvailableCommand, type CommandDto, type CommandStatusValue } from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { PowerIcon, PowerOffIcon, RadarIcon, RotateCwIcon, SendIcon, TerminalIcon, type LucideIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, ErrorBanner, Field, Pill, SectionTitle, Text } from '@/components/ui';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion } from '@/features/live/use-live';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

const ICONS: Record<string, LucideIcon> = { engine_stop: PowerOffIcon, engine_resume: PowerIcon, locate: RadarIcon, status: SendIcon, reboot: RotateCwIcon, custom: TerminalIcon };
const STATUS: Record<CommandStatusValue, { label: string; color: string }> = {
  QUEUED: { label: 'Queued', color: '#64748b' },
  SENT: { label: 'Sent', color: '#2563eb' },
  ACKED: { label: 'Acknowledged', color: '#16a34a' },
  FAILED: { label: 'Failed', color: '#dc2626' },
  EXPIRED: { label: 'Expired', color: '#94a3b8' },
};

/** Send commands to a vehicle's tracker and follow their delivery (same rules as the web Commands tab). */
export default function CommandsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // The React Compiler memoises store reads: tie this one to the live-store version explicitly.
  const version = useLiveVersion(2000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const object = useMemo(() => liveStore.get(id), [id, version]);
  const [pending, setPending] = useState<AvailableCommand | null>(null);
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');

  const available = useQuery({
    queryKey: ['commands-available', id],
    queryFn: ({ signal }) => api.get<AvailableCommand[]>(`/objects/${id}/commands/available`, undefined, signal),
    staleTime: 5 * 60_000,
  });
  const history = useQuery({
    queryKey: ['commands', id],
    queryFn: ({ signal }) => api.get<CommandDto[]>(`/objects/${id}/commands`, undefined, signal),
    refetchInterval: (q) => (q.state.data?.some((x) => x.status === 'QUEUED' || x.status === 'SENT') ? 3000 : false),
  });
  const close = () => {
    setPending(null);
    setPassword('');
    setText('');
  };
  const send = useMutation({
    mutationFn: () =>
      api.post<CommandDto>(`/objects/${id}/commands`, {
        type: pending!.type,
        ...(pending!.type === 'custom' ? { text: text.trim() } : {}),
        ...(pending!.critical ? { password } : {}),
      }),
    onSuccess: (res) => {
      Alert.alert(t(pending!.label), res.status === 'QUEUED' ? t('Sent to the device. Delivery and the reply appear below.') : t(STATUS[res.status].label));
      queryClient.invalidateQueries({ queryKey: ['commands', id] });
      close();
    },
  });

  const offline = !object || object.status === 'OFFLINE' || object.status === 'NO_DATA';
  const blocked = !!pending?.critical && !!object && object.speedKph > ENGINE_STOP_MAX_SPEED_KPH && !offline;
  const ready = !!pending && (!pending.critical || password.length > 0) && (pending.type !== 'custom' || text.trim().length > 0) && !blocked;

  return (
    <>
      <Stack.Screen options={{ title: t('Commands · {{name}}', { name: object?.plateNumber || object?.name || '' }) }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={history.isRefetching} onRefresh={() => void history.refetch()} />}>
        {available.isPending && <ActivityIndicator />}
        {available.isError && <ErrorBanner message={errorMessage(available.error)} onRetry={() => void available.refetch()} />}
        {available.data?.length === 0 && <Text tone="muted">{t("This tracker model doesn't support remote commands.")}</Text>}
        <View style={styles.grid}>
          {available.data?.map((cmd) => {
            const Icon = ICONS[cmd.type] ?? SendIcon;
            return (
              <Pressable
                key={cmd.type}
                onPress={() => setPending(cmd)}
                style={({ pressed }) => [styles.cmd, { borderColor: cmd.critical ? c.destructive : c.border, backgroundColor: c.card }, pressed && { opacity: 0.7 }]}
              >
                <Icon size={20} color={cmd.critical ? c.destructive : c.primary} />
                <Text size="sm" weight="600" style={cmd.critical ? { color: c.destructive } : undefined}>
                  {t(cmd.label)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <SectionTitle>{t('Recent commands')}</SectionTitle>
        {history.data?.length === 0 && <Text tone="muted">{t('No commands sent yet.')}</Text>}
        {history.data?.map((x) => (
          <Card key={x.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text weight="600">{t(COMMAND_DEF_MAP[x.type]?.label ?? x.type)}</Text>
              <Pill label={t(STATUS[x.status].label)} color={STATUS[x.status].color} />
            </View>
            <Text size="xs" tone="muted" style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
              {x.payload}
            </Text>
            {x.response && (
              <Text size="xs" style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), backgroundColor: c.muted, padding: 6, borderRadius: 6 }}>
                {x.response}
              </Text>
            )}
            {x.error && (
              <Text size="xs" tone="destructive">
                {x.error}
              </Text>
            )}
            <Text size="xs" tone="muted">
              {x.createdByName ?? t('Unknown user')} · {formatDateTime(x.createdAt)}
              {x.ackAt ? ` · ${t('replied {{time}}', { time: formatDateTime(x.ackAt) })}` : x.sentAt ? ` · ${t('sent {{time}}', { time: formatDateTime(x.sentAt) })}` : ''}
            </Text>
          </Card>
        ))}
      </ScrollView>

      <Modal visible={!!pending} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
          <View style={[styles.dialog, { backgroundColor: c.card }]}>
            <Text size="lg" weight="700">
              {pending ? t(pending.label) : undefined}
            </Text>
            <Text size="sm" tone="muted">
              {pending ? t(pending.description) : undefined}
            </Text>
            {pending?.type === 'custom' ? (
              <Field label={t('Command text')} value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} maxLength={200} hint={t('Sent exactly as typed, e.g. PARAM# (Concox) or getver (Teltonika).')} />
            ) : (
              <Text size="sm" style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), backgroundColor: c.muted, padding: SPACE.sm, borderRadius: RADIUS.sm }}>
                {pending?.payload}
              </Text>
            )}
            {offline && (
              <Text size="sm" style={{ color: c.warning }}>
                {t('The device is offline. The command is queued and sent when it reconnects (within 24 hours).')}
              </Text>
            )}
            {blocked && (
              <Text size="sm" tone="destructive">
                {t('The vehicle is moving at {{speed}} km/h. Engine stop is only allowed below {{max}} km/h.', { speed: Math.round(object!.speedKph), max: ENGINE_STOP_MAX_SPEED_KPH })}
              </Text>
            )}
            {pending?.critical && !blocked && <Field label={t('Your password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" hint={t('Required to stop an engine.')} />}
            {send.isError && <ErrorBanner message={errorMessage(send.error)} />}
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              <Button title={t('Cancel')} variant="outline" style={{ flex: 1 }} onPress={close} />
              <Button title={pending ? t(pending.label) : t('Send')} variant={pending?.critical ? 'destructive' : 'primary'} style={{ flex: 1 }} disabled={!ready} loading={send.isPending} onPress={() => send.mutate()} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  cmd: { flexBasis: '48%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md },
  backdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: SPACE.lg },
  dialog: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md },
});
