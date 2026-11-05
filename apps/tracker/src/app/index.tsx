import { router } from 'expo-router';
import { ChevronRight, ExternalLink, Play, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AttendanceCard } from '@/components/AttendanceCard';
import { NeedsAttention, useChecks } from '@/components/ChecksCards';
import { SosButton } from '@/components/SosButton';
import { Body, Button, Card } from '@/components/ui';
import { beginTracking, isInactive, permissionsReady, recheckInactive, syncStopReason } from '@/lib/control';
import { ago } from '@/lib/format';
import { LANGUAGES } from '@/lib/language';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { resumeIfWanted, stopTracking, useTrackerStatus } from '@/lib/tracking';

const RECHECK_EVERY_MS = 5 * 60_000;
const PLAY_STORE_VEETRAX = 'https://play.google.com/store/apps/details?id=com.sasvata.veetrax';

/** Opens the VeeTrax app (its veetrax:// scheme), else the download page. */
function openVeetrax() {
  Linking.openURL('veetrax://').catch(() => Linking.openURL(PLAY_STORE_VEETRAX).catch(() => undefined));
}

function NavRow({ title, onPress }: { title: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.navRow, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={[styles.navText, { color: c.text }]}>{title}</Text>
      <ChevronRight color={c.muted} size={20} />
    </Pressable>
  );
}

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
  const required = !!status?.required;
  const on = !!status?.running;
  const killed = !!status && status.wanted && !status.running && !status.stopReason && !busy;
  const queued = status?.queueSize ?? 0;
  const trialEnded = !!session?.trialEndsAt && Date.parse(session.trialEndsAt) < Date.now();
  // Running but its points are not getting through: says so instead of a calm "sent 3 h ago".
  const stuck = on && queued > 0 && !!status?.lastError;

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
    required ? Alert.alert(S.requiredTitle, S.requiredBody) : Alert.alert(S.stopConfirmTitle, S.stopConfirmBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.stopTracking, style: 'destructive', onPress: () => stopTracking().then(refreshStatus) },
    ]);

  const dot = blocked ? c.danger : stuck ? c.accent : on ? c.success : c.muted;
  const line = !on
    ? S.statusOff
    : stuck
      ? S.statusStuck(queued)
      : status?.lastUploadAt
        ? S.statusSent(ago(status.lastUploadAt))
        : S.statusWaiting;

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.scroll}>
      <Card style={[styles.statusCard, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primarySoft : c.card }]}>
        {session?.objectName ? <Body muted>{session.objectName}</Body> : null}
        <View style={styles.statusHead}>
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={[styles.statusTitle, { color: on ? c.primary : c.text }]}>{on ? S.trackingOn : S.trackingOff}</Text>
        </View>
        <Body>{line}</Body>
        {required ? <Body muted>{S.requiredShort}</Body> : null}
        {on && required ? null : on ? (
          <Button title={S.stopTracking} variant="outline" icon={<Square color={c.primary} size={18} />} onPress={stop} />
        ) : (
          <Button title={S.startTracking} icon={<Play color={c.primaryText} size={18} />} onPress={start} busy={busy} disabled={blocked} />
        )}
      </Card>

      <NeedsAttention checks={checks} blocked={blocked} killed={killed} trialEnded={trialEnded} />

      <AttendanceCard />

      <SosButton onDone={refreshStatus} />

      {/* People's own accounts only: on a company phone the company does the viewing. */}
      {session?.accountType === 'INDIVIDUAL' || session?.accountType === 'FAMILY' ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>{S.viewInAppTitle}</Body>
          <Body muted>{S.viewInAppBody(session.email ?? null, session.mobile || `+${session.uniqueId}`)}</Body>
          <Button title={S.openVeetrax} variant="outline" icon={<ExternalLink color={c.primary} size={18} />} onPress={openVeetrax} />
        </Card>
      ) : null}

      <Card style={styles.nav}>
        <NavRow title={S.detailsTitle} onPress={() => router.push('/details')} />
        <View style={[styles.divider, { backgroundColor: c.border }]} />
        <NavRow title={S.profileTitle} onPress={() => router.push('/profile')} />
        <View style={[styles.divider, { backgroundColor: c.border }]} />
        {/* In every language's own script, so someone who can't read the current one still finds theirs. */}
        <NavRow title={LANGUAGES.map((l) => l.label).join(' · ')} onPress={() => router.push('/profile')} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  statusCard: { borderWidth: 2 },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  statusTitle: { flex: 1, fontSize: 26, fontWeight: '800' },
  nav: { paddingVertical: 4, gap: 0 },
  navRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navText: { fontSize: 16, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth },
});
