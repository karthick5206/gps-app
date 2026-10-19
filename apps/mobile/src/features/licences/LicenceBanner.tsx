import { useQuery } from '@tanstack/react-query';
import { LICENCE_EXPIRING_DAYS, type LicenceBannerDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { LockIcon, ShieldAlertIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

/** "N licences expire within 20 days" / "Vehicle X licence expired — renew to view". Tapping opens Licences & invoices. */
export function LicenceBanner() {
  const { t } = useTranslation();
  const c = useColors();
  const { me, can } = useAuth();
  const q = useQuery({
    queryKey: ['licences', 'banner', me?.company.id],
    queryFn: ({ signal }) => api.get<LicenceBannerDto>('/licences/banner', undefined, signal),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const b = q.data;
  if (!b || b.exempt) return null;
  const locked = b.lockedVehicles;
  const parts: string[] = [];
  if (locked.length === 1) parts.push(t('Vehicle {{name}}: licence expired — renew to view its location, history and reports.', { name: locked[0].name }));
  else if (locked.length > 1) parts.push(t('{{n}} vehicles have expired licences ({{names}}) — renew to view them.', { n: locked.length, names: locked.slice(0, 3).map((v) => v.name).join(', ') + (locked.length > 3 ? '…' : '') }));
  if (b.inGrace > 0) parts.push(t('{{n}} licence(s) expired and in the grace period.', { n: b.inGrace }));
  if (b.expiringSoon > 0) parts.push(t('{{n}} licence(s) expire within {{days}} days.', { n: b.expiringSoon, days: LICENCE_EXPIRING_DAYS }));
  if (!parts.length) return null;
  const severe = locked.length > 0 || b.inGrace > 0;
  const color = severe ? c.destructive : c.warning;
  const Icon = severe ? LockIcon : ShieldAlertIcon;
  return (
    <Pressable
      disabled={!can('billing')}
      onPress={() => router.push('/licences')}
      style={({ pressed }) => [{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start', padding: SPACE.md, borderRadius: 12, backgroundColor: `${color}1a` }, pressed && { opacity: 0.7 }]}
    >
      <Icon size={18} color={color} />
      <View style={{ flex: 1 }}>
        <Text size="sm" style={{ color }}>
          {parts.join(' ')}
        </Text>
      </View>
    </Pressable>
  );
}
