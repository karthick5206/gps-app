import Constants from 'expo-constants';
import { DisplaySizeCard } from '@/components/DisplaySizeCard';
import { router, type Href } from 'expo-router';
import { BellRingIcon, BookOpenIcon, Building2Icon, ScanFaceIcon, ChevronRightIcon, CpuIcon, FileBarChartIcon, FileCheck2Icon, HexagonIcon, IdCardIcon, ReceiptIndianRupeeIcon, MapPinIcon, TruckIcon, LogOutIcon, ServerIcon, UserIcon, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { BrandLockup } from '@/components/BrandMark';
import { EmergencyAlertsCard } from '@/components/EmergencyAlertsCard';
import { PushTestButton } from '@/components/PushTestButton';
import { ThemePicker } from '@/components/ThemePicker';
import { Button, Card, InfoRow, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { useRealtimeStatus } from '@/features/live/use-live';
import { pushStatus } from '@/features/notifications/push';
import { LanguageChips } from '@/components/LanguageChips';
import { SERVER_URL } from '@/lib/config';
import { SPACE, useColors } from '@/lib/theme';

function MenuItem({ icon: Icon, label, href, url }: { icon: LucideIcon; label: string; href?: Href; url?: string }) {
  const c = useColors();
  return (
    <Pressable onPress={() => (url ? Linking.openURL(url).catch(() => undefined) : href && router.push(href))} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}>
      <Icon size={20} color={c.primary} />
      <Text style={{ flex: 1 }}>{label}</Text>
      <ChevronRightIcon size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

const CONNECTION_LABEL = { idle: 'Not connected', connecting: 'Connecting…', connected: 'Live', disconnected: 'Reconnecting…' } as const;

export default function MoreScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const { me, signOut, can } = useAuth();
  const connection = useRealtimeStatus();
  const confirmSignOut = () =>
    Alert.alert(t('Sign out?'), t('You will need to sign in again to see your vehicles.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Sign out'), style: 'destructive', onPress: signOut },
    ]);
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
      <View style={{ paddingVertical: SPACE.xs }}>
        <BrandLockup size={40} color={c.foreground} sub={t('Version {{version}}', { version: Constants.expoConfig?.version ?? '—' })} />
      </View>
      <Card onPress={() => router.push('/profile')}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
            <UserIcon size={24} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text size="lg" weight="700">
              {me?.user.name ?? '—'}
            </Text>
            <Text size="sm" tone="muted">
              {me?.user.email ?? me?.user.mobile ?? ''}
            </Text>
          </View>
          <ChevronRightIcon size={18} color={c.mutedForeground} />
        </View>
      </Card>

      {me?.user.isSuperAdmin && (
        // Super Admin acts in one company at a time (same as the web company switcher).
        <Card onPress={() => router.push('/company')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            <Building2Icon size={22} color={c.primary} />
            <View style={{ flex: 1 }}>
              <Text size="sm" tone="muted">
                {t('Company')}
              </Text>
              <Text weight="700" numberOfLines={1}>
                {me.company.name}
              </Text>
            </View>
            <Text size="sm" style={{ color: c.primary }}>
              {t('Switch')}
            </Text>
            <ChevronRightIcon size={18} color={c.mutedForeground} />
          </View>
        </Card>
      )}

      <Card style={{ paddingVertical: 0 }}>
        {can('driver_events') && <MenuItem icon={ScanFaceIcon} label={t('Driver events')} href="/driver-events" />}
        {can('reports') && <MenuItem icon={FileBarChartIcon} label={t('Reports')} href="/reports" />}
        {can('objects') && <MenuItem icon={TruckIcon} label={t('Vehicles')} href="/manage/vehicles" />}
        {can('devices') && <MenuItem icon={CpuIcon} label={t('Devices')} href="/manage/devices" />}
        {can('drivers') && <MenuItem icon={IdCardIcon} label={t('Drivers')} href="/manage/drivers" />}
        {can('documents') && <MenuItem icon={FileCheck2Icon} label={t('Documents & service')} href="/documents" />}
        {can('geofences') && <MenuItem icon={HexagonIcon} label={t('Geofences')} href="/geofences" />}
        {can('pois') && <MenuItem icon={MapPinIcon} label={t('Points of interest')} href="/pois" />}
        {can('alert_settings') && <MenuItem icon={BellRingIcon} label={t('Alert settings')} href="/alert-settings" />}
        {can('billing') && !me?.user.isSuperAdmin && <MenuItem icon={ReceiptIndianRupeeIcon} label={t('Licences & invoices')} href="/licences" />}
        {/* Public web page (same content as the PDF emailed on sign-up). */}
        <MenuItem icon={BookOpenIcon} label={t('Getting-started guide')} url={`${SERVER_URL}/guide`} />
      </Card>

      <SectionTitle>{t('Account')}</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Company')} value={me?.company.name ?? '—'} />
        <InfoRow label={t('Time zone')} value={me?.company.timezone ?? '—'} />
        <InfoRow label={t('Data access')} value={me?.dataScope === 'ASSIGNED' ? t('Assigned branches / vehicles') : t('Whole company')} />
      </Card>

      <SectionTitle>{t('Language')}</SectionTitle>
      <Card>
        <LanguageChips />
      </Card>

      <SectionTitle>{t('Display size')}</SectionTitle>
      <DisplaySizeCard />

      <SectionTitle>{t('Appearance')}</SectionTitle>
      <Card style={{ gap: SPACE.sm, paddingVertical: SPACE.xs }}>
        <ThemePicker />
        <Text size="xs" tone="muted" style={{ paddingBottom: SPACE.sm }}>
          {t('Saved to your profile, so the web app uses the same theme.')}
        </Text>
      </Card>

      <SectionTitle>{t('App')}</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Live connection')} value={t(CONNECTION_LABEL[connection])} />
        <InfoRow label={t('Push alerts')} value={pushStatus ? t(pushStatus) : t('On')} />
        <InfoRow
          label={t('Server')}
          value={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ServerIcon size={14} color={c.mutedForeground} />
              <Text size="sm">{SERVER_URL.replace(/^https?:\/\//, '')}</Text>
            </View>
          }
        />
        <InfoRow label={t('Version')} value={Constants.expoConfig?.version ?? '—'} />
      </Card>
      <PushTestButton />

      <SectionTitle>{t('Emergency alerts')}</SectionTitle>
      <EmergencyAlertsCard />

      <Button title={t('Sign out')} icon={LogOutIcon} variant="outline" onPress={confirmSignOut} style={{ marginTop: SPACE.md }} />
    </ScrollView>
  );
}
