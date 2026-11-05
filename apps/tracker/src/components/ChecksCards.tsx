import { router } from 'expo-router';
import { BatteryWarning, MapPinOff, Rocket, ShieldAlert, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { batteryOptimised, notificationsGranted, openAppSettings, openBatterySettings } from '@/lib/device';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { readPermissions, Tracker, type PermissionState } from '@/lib/tracking';
import { Body, Button, Card, Row, Title } from './ui';

export interface Checks { perms: PermissionState | null; notifications: boolean; batteryOpt: boolean }

/** Permission and battery-optimisation state, re-read whenever the app comes back to the foreground. */
export function useChecks(): [Checks, () => void] {
  const [checks, setChecks] = useState<Checks>({ perms: null, notifications: true, batteryOpt: false });
  const refresh = useCallback(() => {
    Promise.all([readPermissions().catch(() => null), notificationsGranted(), batteryOptimised()])
      .then(([perms, notifications, batteryOpt]) => setChecks({ perms, notifications, batteryOpt }))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);
  return [checks, refresh];
}

/** One line per problem with its one fix, so a phone with several problems still shows Attendance and SOS without much scrolling. */
function Issue({ icon, title, body, danger, onFix }: { icon?: ReactNode; title: string; body?: string; danger?: boolean; onFix?: () => void }) {
  const c = useColors();
  return (
    <View style={styles.issue}>
      <View style={styles.issueRow}>
        {icon}
        <Text style={[styles.issueTitle, { color: danger ? c.danger : c.text }]}>{title}</Text>
        {onFix ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`${S.fix}: ${title}`} onPress={onFix} hitSlop={6} style={({ pressed }) => [styles.fix, { backgroundColor: c.accent, opacity: pressed ? 0.8 : 1 }]}>
            <Text style={styles.fixText}>{S.fix}</Text>
          </Pressable>
        ) : null}
      </View>
      {body ? <Body style={{ color: c.accentText }}>{body}</Body> : null}
    </View>
  );
}

/** Everything stopping tracking or about to, most serious first. Hidden when all is well. */
export function NeedsAttention({ checks, blocked, killed, trialEnded }: { checks: Checks; blocked: boolean; killed: boolean; trialEnded: boolean }) {
  useStoreVersion();
  const c = useColors();
  const p = checks.perms;
  const permsMissing = !!p && (!p.foreground || !p.precise || !p.background || !checks.notifications);
  const locationOff = !!p && !p.servicesOn;
  const oem = Platform.OS === 'android' && !store.oemDone();
  if (!blocked && !killed && !trialEnded && !locationOff && !permsMissing && !checks.batteryOpt && !oem) return null;
  return (
    <Card tone={blocked ? 'danger' : 'warn'} style={{ gap: 14 }}>
      <Title>{S.attentionTitle}</Title>
      {blocked ? <Issue danger title={S.reasonInactive} /> : null}
      {killed ? <Issue title={S.notRunningTitle} body={S.notRunningBody} /> : null}
      {locationOff ? <Issue icon={<MapPinOff color={c.accent} size={22} />} title={S.locationOffShort} onFix={openAppSettings} /> : null}
      {permsMissing ? <Issue icon={<ShieldAlert color={c.accent} size={22} />} title={p?.background ? S.permMissingTitle : S.permAllowAlways} onFix={openAppSettings} /> : null}
      {checks.batteryOpt ? <Issue icon={<BatteryWarning color={c.accent} size={22} />} title={S.batteryTitle} onFix={() => openBatterySettings()} /> : null}
      {oem ? <Issue icon={<Rocket color={c.accent} size={22} />} title={S.oemTitle} onFix={() => router.push('/details')} /> : null}
      {trialEnded ? <Issue title={S.trialEnded} /> : null}
    </Card>
  );
}

/**
 * Phone-maker (OEM) background settings: Xiaomi / Oppo / Realme / Vivo / OnePlus / Samsung / Huawei kill background
 * apps beyond what Android does. The button tries the maker's autostart screen, else opens App info.
 * "I've done this" takes it off the home screen; the steps stay here.
 */
export function OemCard() {
  useStoreVersion();
  const c = useColors();
  if (Platform.OS !== 'android') return null;
  const done = store.oemDone();
  return (
    <Card tone={done ? undefined : 'warn'}>
      <View style={styles.head}>
        <Rocket color={c.accent} size={22} />
        <Title>{S.oemTitle}</Title>
      </View>
      <Body style={done ? undefined : { color: c.accentText }}>{S.oemBody(Tracker.manufacturer())}</Body>
      <Button title={S.oemButton} variant={done ? 'outline' : 'accent'} onPress={() => Tracker.openAutostartSettings().catch(openAppSettings)} />
      {done ? null : <Button title={S.oemDone} variant="ghost" onPress={() => store.setOemDone(true)} />}
    </Card>
  );
}

export function PermissionsCard({ checks }: { checks: Checks }) {
  const c = useColors();
  const p = checks.perms;
  if (!p) return null;
  const v = (ok: boolean) => ({ value: ok ? S.permGranted : S.permDenied, valueColor: ok ? c.success : c.danger });
  const allOk = p.servicesOn && p.foreground && p.precise && p.background && checks.notifications;
  return (
    <Card>
      <View style={styles.head}>
        <ShieldCheck color={allOk ? c.success : c.accent} size={22} />
        <Title>{S.permissionsTitle}</Title>
      </View>
      {!p.servicesOn ? <Body style={{ color: c.danger, fontWeight: '600' }}>{S.permLocationOff}</Body> : null}
      <Row label={S.permLocation} {...v(p.foreground)} />
      <Row label={S.permPrecise} {...v(p.precise)} />
      <Row label={S.permBackground} {...v(p.background)} />
      <Row label={S.permNotifications} {...v(checks.notifications)} />
      {!p.background ? <Body muted>{S.permBackgroundHelp}</Body> : null}
      {!allOk ? <Button title={S.openSettings} variant="outline" onPress={openAppSettings} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  issue: { gap: 6 },
  issueRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  issueTitle: { flex: 1, fontSize: 15, fontWeight: '700' },
  fix: { minHeight: 40, minWidth: 64, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fixText: { color: '#1f1300', fontSize: 15, fontWeight: '800' },
});
