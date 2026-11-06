import { router } from 'expo-router';
import { EllipsisVertical, ExternalLink, Play, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AttendanceCard } from '@/components/AttendanceCard';
import { NeedsAttention, useChecks } from '@/components/ChecksCards';
import { HomeMenu } from '@/components/HomeMenu';
import { LanguagePicker } from '@/components/LanguagePicker';
import { SosButton } from '@/components/SosButton';
import { BlinkDot, StatusPulse, type LiveState } from '@/components/StatusPulse';
import { TrackerMark } from '@/components/TrackerLogo';
import { Body, Button, Card, HeaderBand, HeaderIconButton, toneColors } from '@/components/ui';
import { beginTracking, isInactive, permissionsReady, recheckInactive, syncStopReason } from '@/lib/control';
import { ago } from '@/lib/format';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { resumeIfWanted, stopTracking, useTrackerStatus } from '@/lib/tracking';

const RECHECK_EVERY_MS = 5 * 60_000;
const PLAY_STORE_VEETRAX = 'https://play.google.com/store/apps/details?id=com.sasvata.veetrax';
const LIVE_TONE = { live: 'success', waiting: 'warn', off: 'idle', blocked: 'danger' } as const;

/** Opens the VeeTrax app (its veetrax:// scheme), else the download page. */
function openVeetrax() {
  Linking.openURL('veetrax://').catch(() => Linking.openURL(PLAY_STORE_VEETRAX).catch(() => undefined));
}

export default function HomeScreen() {
  useStoreVersion();
  const c = useColors();
  const [checks, refreshChecks] = useChecks();
  const [status, refreshStatus] = useTrackerStatus();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  // live = points are getting through; waiting = on but nothing sent yet, or stuck; blocked = switched off by the admin.
  const live: LiveState = blocked ? 'blocked' : !on ? 'off' : stuck || !status?.lastUploadAt ? 'waiting' : 'live';
  const tone = toneColors(c, LIVE_TONE[live]);
  const line = !on
    ? S.statusOff
    : stuck
      ? S.statusStuck(queued)
      : status?.lastUploadAt
        ? S.statusSent(ago(status.lastUploadAt))
        : S.statusWaiting;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <HeaderBand
        logo={<TrackerMark size={34} />}
        title={S.appName}
        subtitle={session?.objectName || null}
        right={<HeaderIconButton icon={<EllipsisVertical color={c.headerText} size={22} />} label={S.menu} onPress={() => setMenuOpen(true)} />}
      />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card style={[styles.statusCard, { borderColor: on || blocked ? tone.dot : c.border }]}>
          <View style={styles.statusHead}>
            <StatusPulse state={live} />
            <View style={styles.statusText}>
              <Text style={[styles.statusTitle, { color: on || blocked ? tone.fg : c.text }]} accessibilityLiveRegion="polite">
                {on ? S.trackingOn : S.trackingOff}
              </Text>
              <View style={styles.lineRow}>
                {on ? <BlinkDot run={live === 'live'} color={tone.dot} /> : null}
                <Body muted style={styles.line}>
                  {line}
                </Body>
              </View>
            </View>
          </View>
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

        {/* Language after activation: right on the home screen, each in its own script so anyone can find theirs. */}
        <View style={styles.language}>
          <LanguagePicker />
        </View>

        {/* People's own accounts only: on a company phone the company does the viewing. */}
        {session?.accountType === 'INDIVIDUAL' || session?.accountType === 'FAMILY' ? (
          <Card>
            <Body style={{ fontWeight: '700' }}>{S.viewInAppTitle}</Body>
            <Body muted>{S.viewInAppBody(session.email ?? null, session.mobile || `+${session.uniqueId}`)}</Body>
            <Button title={S.openVeetrax} variant="outline" icon={<ExternalLink color={c.primary} size={18} />} onPress={openVeetrax} />
          </Card>
        ) : null}

      </ScrollView>
      <HomeMenu open={menuOpen} onClose={() => setMenuOpen(false)} status={status} />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  statusCard: { borderWidth: 1.5, gap: 14 },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  statusText: { flex: 1, minWidth: 0, gap: 4 },
  statusTitle: { fontSize: 24, fontWeight: '800' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { flex: 1 },
  language: { paddingTop: 4 },
});
