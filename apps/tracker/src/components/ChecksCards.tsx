import { BatteryWarning, ShieldCheck } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { batteryOptimised, notificationsGranted, openAppSettings, openBatterySettings } from '@/lib/device';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { readPermissions, type PermissionState } from '@/lib/tracking';
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

export function BatteryCard({ show }: { show: boolean }) {
  const c = useColors();
  if (!show) return null;
  return (
    <Card tone="warn">
      <View style={styles.head}>
        <BatteryWarning color={c.accent} size={22} />
        <Title>{S.batteryTitle}</Title>
      </View>
      <Body style={{ color: c.accentText }}>{S.batteryBody}</Body>
      <Button title={S.batteryButton} variant="accent" onPress={() => openBatterySettings()} />
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
});
