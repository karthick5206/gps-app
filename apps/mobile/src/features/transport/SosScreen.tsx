import { router, type Href } from 'expo-router';
import { SirenIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Card, Text } from '@/components/ui';
import { SPACE, toneColors, useColors } from '@/lib/theme';
import { useNow } from './passenger-api';
import { SosPanel } from './passenger/SosPanel';
import { useMyPolicy } from './self-service-api';
import { sosTripIdAt } from './sos-context';
import { sosChannelFor, useSosContext, type SosAudience } from './sos-store';

export const SOS_HREF: Record<SosAudience, Href> = { passenger: '/commute/sos', driver: '/duty/sos' };

/**
 * The SOS block itself (hold button, honest status, call buttons) for one audience. Works with no network: the trip
 * and the desk phone come from the remembered SOS context (sos-context.ts), the SOS goes into the offline queue.
 */
export function SosContent({ audience, online = true }: { audience: SosAudience; online?: boolean }) {
  const { t } = useTranslation();
  const channel = sosChannelFor(audience);
  const ctx = useSosContext(channel);
  const now = useNow(30_000);
  // Passenger: a server that said it has no passenger SOS route (`policy.sos === false`) gets only the call buttons. An
  // unknown policy (offline, still loading, error) never hides the button: the queue keeps the SOS and says so.
  const policy = useMyPolicy(online && audience === 'passenger').data;
  const enabled = audience === 'driver' || policy?.sos !== false;
  const tripId = sosTripIdAt(ctx, now);
  const deskPhone = (audience === 'passenger' ? policy?.deskPhone : null) ?? ctx.deskPhone;
  return (
    <View style={{ gap: SPACE.md }}>
      <Text size="sm" tone="muted">
        {audience === 'driver'
          ? t('Hold the red button for 2 seconds to alert the dispatcher. The SOS is saved on this phone first and sent as soon as there is a connection.')
          : t('Hold the red button for 2 seconds to alert the transport desk. The SOS is saved on this phone first and sent as soon as there is a connection.')}
      </Text>
      <SosPanel channel={channel} enabled={enabled} tripId={null} deskPhone={deskPhone} large />
      <Card style={{ gap: SPACE.xs }}>
        <Text size="sm">{tripId ? t('Your current trip is sent with the SOS.') : t('No current trip is known on this phone. The SOS is sent without a trip.')}</Text>
        <Text size="xs" tone="muted">
          {t('This app does not send your phone’s location with the SOS.')}
        </Text>
      </Card>
    </View>
  );
}

/** Full-screen SOS (passenger `/commute/sos`, driver `/duty/sos`; doc 08 §4.2, doc 09 §5 / §7.3). */
export function SosScreen({ audience }: { audience: SosAudience }) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <SosContent audience={audience} />
    </ScrollView>
  );
}

/** Red "SOS" header button: one tap from every passenger / driver screen to the SOS screen (≥ 48 dp with its slop). */
export function SosHeaderButton({ audience }: { audience: SosAudience }) {
  const { t } = useTranslation();
  const c = useColors();
  const tc = toneColors(c, 'destructive');
  return (
    <Pressable
      onPress={() => router.push(SOS_HREF[audience])}
      accessibilityRole="button"
      accessibilityLabel={t('SOS')}
      accessibilityHint={t('Opens the SOS screen')}
      hitSlop={10}
      style={({ pressed }) => [styles.header, { backgroundColor: tc.solid, borderColor: '#ffffff' }, pressed && { opacity: 0.8 }]}
    >
      <SirenIcon size={18} color="#ffffff" />
      <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: 15 }}>{t('SOS')}</Text>
    </Pressable>
  );
}

/** Large in-page SOS entry (driver Today / trip screens: allowed while moving, doc 09 §5.1). */
export function SosEntryButton({ audience }: { audience: SosAudience }) {
  const { t } = useTranslation();
  const c = useColors();
  const tc = toneColors(c, 'destructive');
  return (
    <Pressable
      onPress={() => router.push(SOS_HREF[audience])}
      accessibilityRole="button"
      accessibilityLabel={t('SOS')}
      accessibilityHint={t('Opens the SOS screen')}
      style={({ pressed }) => [styles.entry, { backgroundColor: tc.solid }, pressed && { opacity: 0.8 }]}
    >
      <SirenIcon size={28} color="#ffffff" />
      <Text style={{ color: '#ffffff', fontWeight: '800', fontSize: 20 }}>{t('SOS')}</Text>
    </Pressable>
  );
}

/** headerRight factory for screen options. */
export function sosHeaderRight(audience: SosAudience) {
  return function SosHeaderRight() {
    return <SosHeaderButton audience={audience} />;
  };
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, minWidth: 64, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, justifyContent: 'center', marginHorizontal: 8 },
  entry: { minHeight: 72, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.lg },
});
