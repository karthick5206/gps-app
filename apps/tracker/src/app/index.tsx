import { router } from 'expo-router';
import { LogOut, Play, Square, UploadCloud } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, AppState, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { BatteryCard, PermissionsCard, useChecks } from '@/components/ChecksCards';
import { SosButton } from '@/components/SosButton';
import { Body, Button, Card, Row } from '@/components/ui';
import { beginTracking, permissionsReady } from '@/lib/control';
import { queueSize } from '@/lib/db';
import { kmh, metres, timeAgo } from '@/lib/format';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { isRunning, resumeIfWanted, stopTracking } from '@/lib/tracking';
import { flush, recheckBlocked, signOut } from '@/lib/uploader';

const UPLOAD_EVERY_MS = 30_000;

export default function HomeScreen() {
  useStoreVersion();
  const c = useColors();
  const [checks, refreshChecks] = useChecks();
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // Refresh the "running" flag and relative times every 2 s; upload every 30 s while the app is open.
  useEffect(() => {
    const poll = () => isRunning().then(setRunning).catch(() => undefined);
    poll();
    const fast = setInterval(() => (poll(), setTick((n) => n + 1)), 2000);
    const slow = setInterval(() => {
      flush().catch(() => undefined);
      recheckBlocked().catch(() => undefined);
    }, UPLOAD_EVERY_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      resumeIfWanted().then(poll).catch(() => undefined);
      flush().catch(() => undefined);
    });
    return () => (clearInterval(fast), clearInterval(slow), sub.remove());
  }, []);

  const session = store.session();
  const status = store.status();
  const blocked = store.blocked();
  const on = store.wanted() && running;
  const queued = queueSize();

  const start = async () => {
    if (!(await permissionsReady())) return router.push('/disclosure');
    setBusy(true);
    const r = await beginTracking();
    setBusy(false);
    setRunning(await isRunning());
    refreshChecks();
    if (!r.ok) Alert.alert(S.appName, r.message);
  };

  const stop = () =>
    Alert.alert(S.stopConfirmTitle, S.stopConfirmBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.stopTracking, style: 'destructive', onPress: () => stopTracking().then(() => setRunning(false)) },
    ]);

  const deactivate = () =>
    Alert.alert(S.signOutConfirmTitle, S.signOutConfirmBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.ok, style: 'destructive', onPress: () => signOut(S.reasonSignedOut) },
    ]);

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.scroll}>
      {session ? (
        <Card>
          <Row label={S.trackingFor} value={session.objectName || `+${session.uniqueId}`} />
          <Row label={S.company} value={session.companyName || '—'} />
        </Card>
      ) : null}

      {blocked ? (
        <Card tone="danger">
          <Body style={{ color: c.danger, fontWeight: '700' }}>{S.reasonInactive}</Body>
        </Card>
      ) : null}

      <Card style={[styles.toggleCard, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primarySoft : c.card }]}>
        <View style={styles.toggleHead}>
          <View style={[styles.dot, { backgroundColor: on ? c.success : c.muted }]} />
          <Text style={[styles.toggleTitle, { color: on ? c.primary : c.text }]}>{on ? S.trackingOn : S.trackingOff}</Text>
          <Switch
            value={on}
            onValueChange={(v) => (v ? start() : stop())}
            disabled={busy || !!blocked}
            trackColor={{ true: c.primary, false: c.border }}
            thumbColor={on ? c.accent : '#f4f4f5'}
          />
        </View>
        {on ? (
          <Button title={S.stopTracking} variant="outline" icon={<Square color={c.primary} size={18} />} onPress={stop} />
        ) : (
          <Button title={S.startTracking} icon={<Play color={c.primaryText} size={18} />} onPress={start} busy={busy} disabled={!!blocked} />
        )}
        <Row label={S.lastFix} value={timeAgo(status.lastFixAt)} />
        <Row label={S.accuracy} value={metres(status.lastAcc)} />
        <Row label={S.speed} value={kmh(status.lastSpd)} />
        <Row label={S.waiting} value={S.points(queued)} valueColor={queued > 0 ? c.accentText : undefined} />
        <Row label={S.lastUpload} value={timeAgo(status.lastUploadAt)} />
        {status.lastError ? <Row label={S.uploadError} value={status.lastError} valueColor={c.danger} /> : null}
        {queued > 0 ? (
          <Button title={S.uploadNow} variant="ghost" icon={<UploadCloud color={c.muted} size={18} />} onPress={() => flush(true)} />
        ) : null}
      </Card>

      <SosButton />

      <BatteryCard show={checks.batteryOpt} />
      <PermissionsCard checks={checks} />

      <Button title={S.signOut} variant="ghost" icon={<LogOut color={c.muted} size={18} />} onPress={deactivate} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  toggleCard: { borderWidth: 2 },
  toggleHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  toggleTitle: { flex: 1, fontSize: 22, fontWeight: '800' },
});
