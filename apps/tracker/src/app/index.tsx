import { router } from 'expo-router';
import { ExternalLink, LogOut, Play, Square, UploadCloud } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { BatteryCard, OemCard, PermissionsCard, useChecks } from '@/components/ChecksCards';
import { SosButton } from '@/components/SosButton';
import { Body, Button, Card, Row } from '@/components/ui';
import { beginTracking, isInactive, permissionsReady, recheckInactive, signOut, syncStopReason } from '@/lib/control';
import { kmh, metres, timeAgo } from '@/lib/format';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { resumeIfWanted, stopTracking, Tracker, useTrackerStatus } from '@/lib/tracking';

const RECHECK_EVERY_MS = 5 * 60_000;
const WEB_URL = 'https://app.veetrax.com';

/** Opens the VeeTrax app (its veetrax:// scheme), else the download page. */
function openVeetrax() {
  Linking.openURL('veetrax://').catch(() => Linking.openURL(`${WEB_URL}/download`).catch(() => undefined));
}

const dateOnly = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function HomeScreen() {
  useStoreVersion();
  const c = useColors();
  const [checks, refreshChecks] = useChecks();
  const [status, refreshStatus] = useTrackerStatus();
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // React to stops decided natively (REVOKED / INVALID → sign out).
  useEffect(() => {
    syncStopReason(status).catch(() => undefined);
  }, [status?.stopReason]);

  // On return to the foreground: restart if wanted but killed; every few minutes: INACTIVE re-check (hourly inside).
  useEffect(() => {
    const slow = setInterval(() => recheckInactive(statusRef.current).catch(() => undefined), RECHECK_EVERY_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      resumeIfWanted().then(refreshStatus).catch(() => undefined);
      recheckInactive(statusRef.current).catch(() => undefined);
    });
    return () => (clearInterval(slow), sub.remove());
  }, []);

  const session = store.session();
  const blocked = isInactive(status);
  const on = !!status?.running;
  const killed = !!status && status.wanted && !status.running && !status.stopReason;
  const queued = status?.queueSize ?? 0;

  const start = async () => {
    if (!(await permissionsReady())) return router.push('/disclosure');
    setBusy(true);
    const r = await beginTracking();
    setBusy(false);
    refreshStatus();
    refreshChecks();
    if (!r.ok) Alert.alert(S.appName, r.message);
  };

  const stop = () =>
    Alert.alert(S.stopConfirmTitle, S.stopConfirmBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.stopTracking, style: 'destructive', onPress: () => stopTracking().then(refreshStatus) },
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
          <Row label={S.mobile} value={session.mobile || `+${session.uniqueId}`} />
          {session.email ? <Row label={S.email} value={session.email} /> : null}
          {session.accountType ? <Row label={S.accountType} value={S.accountTypes[session.accountType] ?? session.accountType} /> : null}
          <Row label={S.company} value={session.companyName || '—'} />
          {session.trialEndsAt ? (
            <Row label={S.freeTrialUntil} value={dateOnly(session.trialEndsAt)} />
          ) : session.licenceEndsAt ? (
            <Row label={S.licenceUntil} value={dateOnly(session.licenceEndsAt)} />
          ) : null}
        </Card>
      ) : null}

      {session?.trialEndsAt && Date.parse(session.trialEndsAt) < Date.now() ? (
        <Card tone="warn">
          <Body style={{ color: c.accentText, fontWeight: '700' }}>{S.trialEnded}</Body>
        </Card>
      ) : null}

      {blocked ? (
        <Card tone="danger">
          <Body style={{ color: c.danger, fontWeight: '700' }}>{S.reasonInactive}</Body>
        </Card>
      ) : null}

      {killed && !busy ? (
        <Card tone="warn">
          <Body style={{ color: c.accentText, fontWeight: '700' }}>{S.notRunningTitle}</Body>
          <Body style={{ color: c.accentText }}>{S.notRunningBody}</Body>
        </Card>
      ) : null}

      <Card style={[styles.toggleCard, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primarySoft : c.card }]}>
        <View style={styles.toggleHead}>
          <View style={[styles.dot, { backgroundColor: on ? c.success : c.muted }]} />
          <Text style={[styles.toggleTitle, { color: on ? c.primary : c.text }]}>{on ? S.trackingOn : S.trackingOff}</Text>
          <Switch
            value={on}
            onValueChange={(v) => (v ? start() : stop())}
            disabled={busy || blocked}
            trackColor={{ true: c.primary, false: c.border }}
            thumbColor={on ? c.accent : '#f4f4f5'}
          />
        </View>
        {on ? (
          <Button title={S.stopTracking} variant="outline" icon={<Square color={c.primary} size={18} />} onPress={stop} />
        ) : (
          <Button title={S.startTracking} icon={<Play color={c.primaryText} size={18} />} onPress={start} busy={busy} disabled={blocked} />
        )}
        <Row label={S.lastFix} value={timeAgo(status?.lastFixAt ?? undefined)} />
        <Row label={S.accuracy} value={metres(status?.lastAcc)} />
        <Row label={S.speed} value={kmh(status?.lastSpd)} />
        {on ? <Row label={S.mode} value={status?.mode === 'stationary' ? S.modeStationary : S.modeMoving} /> : null}
        <Row label={S.waiting} value={S.points(queued)} valueColor={queued > 0 ? c.accentText : undefined} />
        <Row label={S.lastUpload} value={timeAgo(status?.lastUploadAt ?? undefined)} />
        {status && (status.droppedCount > 0 || status.mockCount > 0) ? (
          <Row label={S.filtered} value={S.filteredValue(status.droppedCount, status.mockCount)} />
        ) : null}
        {status?.lastError ? <Row label={S.uploadError} value={status.lastError} valueColor={c.danger} /> : null}
        {queued > 0 ? (
          <Button
            title={S.uploadNow}
            variant="ghost"
            icon={<UploadCloud color={c.muted} size={18} />}
            onPress={() => Tracker.flush().then(refreshStatus)}
          />
        ) : null}
      </Card>

      <SosButton onDone={refreshStatus} />

      <BatteryCard show={checks.batteryOpt} />
      <OemCard />
      <PermissionsCard checks={checks} />

      {session ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>{S.viewInAppTitle}</Body>
          <Body muted>{S.viewInAppBody(session.email ?? null, session.mobile || `+${session.uniqueId}`)}</Body>
          <Button title={S.openVeetrax} variant="outline" icon={<ExternalLink color={c.primary} size={18} />} onPress={openVeetrax} />
        </Card>
      ) : null}

      <View style={styles.legal}>
        <Text style={[styles.legalLink, { color: c.muted }]} onPress={() => Linking.openURL(`${WEB_URL}/privacy`).catch(() => undefined)}>
          {S.privacyPolicy}
        </Text>
        <Text style={[styles.legalLink, { color: c.muted }]} onPress={() => Linking.openURL(`${WEB_URL}/delete-account`).catch(() => undefined)}>
          {S.deleteAccount}
        </Text>
      </View>

      <Button title={S.signOut} variant="ghost" icon={<LogOut color={c.muted} size={18} />} onPress={deactivate} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  legal: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 4 },
  legalLink: { fontSize: 13, textDecorationLine: 'underline' },
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  toggleCard: { borderWidth: 2 },
  toggleHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  toggleTitle: { flex: 1, fontSize: 22, fontWeight: '800' },
});
