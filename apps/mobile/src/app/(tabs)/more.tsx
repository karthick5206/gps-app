import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { ChevronRightIcon, FileBarChartIcon, LogOutIcon, ServerIcon, UserIcon, type LucideIcon } from 'lucide-react-native';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, InfoRow, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { useRealtimeStatus } from '@/features/live/use-live';
import { SERVER_URL } from '@/lib/config';
import { SPACE, useColors } from '@/lib/theme';

function MenuItem({ icon: Icon, label, href }: { icon: LucideIcon; label: string; href: Href }) {
  const c = useColors();
  return (
    <Pressable onPress={() => router.push(href)} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}>
      <Icon size={20} color={c.primary} />
      <Text style={{ flex: 1 }}>{label}</Text>
      <ChevronRightIcon size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

const CONNECTION_LABEL = { idle: 'Not connected', connecting: 'Connecting…', connected: 'Live', disconnected: 'Reconnecting…' } as const;

export default function MoreScreen() {
  const c = useColors();
  const { me, signOut, can } = useAuth();
  const connection = useRealtimeStatus();
  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'You will need to sign in again to see your vehicles.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
      <Card>
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
        </View>
      </Card>

      <Card style={{ paddingVertical: 0 }}>
        {can('reports') && <MenuItem icon={FileBarChartIcon} label="Reports" href="/reports" />}
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label="Company" value={me?.company.name ?? '—'} />
        <InfoRow label="Time zone" value={me?.company.timezone ?? '—'} />
        <InfoRow label="Data access" value={me?.dataScope === 'ASSIGNED' ? 'Assigned branches / vehicles' : 'Whole company'} />
      </Card>

      <SectionTitle>App</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label="Live connection" value={CONNECTION_LABEL[connection]} />
        <InfoRow
          label="Server"
          value={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ServerIcon size={14} color={c.mutedForeground} />
              <Text size="sm">{SERVER_URL.replace(/^https?:\/\//, '')}</Text>
            </View>
          }
        />
        <InfoRow label="Version" value={Constants.expoConfig?.version ?? '—'} />
      </Card>

      <Button title="Sign out" icon={LogOutIcon} variant="outline" onPress={confirmSignOut} style={{ marginTop: SPACE.md }} />
    </ScrollView>
  );
}
