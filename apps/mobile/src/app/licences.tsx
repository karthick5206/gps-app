import { useMutation, useQuery } from '@tanstack/react-query';
import { formatInr, LICENCE_EXPIRING_DAYS, LICENCE_TYPE_LABELS, LICENCE_TYPES, type InvoiceDto, type LicenceOverviewDto } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { ExternalLinkIcon, FileDownIcon, FileTextIcon, ShieldCheckIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, EmptyState, ErrorBanner, Pill, SectionTitle, Text } from '@/components/ui';
import { LicenceBanner } from '@/features/licences/LicenceBanner';
import { api, errorMessage } from '@/lib/api';
import { SERVER_URL } from '@/lib/config';
import { downloadAndShare } from '@/lib/share-file';
import { SPACE, useColors } from '@/lib/theme';

const rupees = (paise: number) => `₹${formatInr(paise)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

/** More → Licences & invoices (admins): seat summary, what expires soon, invoices; buying and renewing happen on the web. */
export default function LicencesScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const overview = useQuery({ queryKey: ['licences', 'overview'], queryFn: ({ signal }) => api.get<LicenceOverviewDto>('/licences/overview', undefined, signal) });
  const invoices = useQuery({ queryKey: ['licences', 'invoices'], queryFn: ({ signal }) => api.get<InvoiceDto[]>('/licences/invoices', undefined, signal) });
  const share = useMutation({
    mutationFn: (inv: InvoiceDto) => downloadAndShare(`/licences/invoices/${inv.id}/pdf`, { fallbackName: `Invoice-${inv.number.replace(/\//g, '-')}.pdf` }),
    onError: (err) => Alert.alert(t('Could not open the invoice'), errorMessage(err)),
  });
  const refresh = () => {
    void overview.refetch();
    void invoices.refetch();
  };
  const o = overview.data;
  const expiring = (o?.seats ?? []).filter((s) => s.subject && s.status !== 'ACTIVE');
  return (
    <>
      <Stack.Screen options={{ title: t('Licences & invoices') }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={overview.isRefetching} onRefresh={refresh} />}>
        <LicenceBanner />
        {overview.isPending && <ActivityIndicator style={{ margin: SPACE.xl }} />}
        {overview.isError && <ErrorBanner message={errorMessage(overview.error)} onRetry={refresh} />}
        {o && (
          <>
            <SectionTitle>{t('Licences')}</SectionTitle>
            <View style={styles.grid}>
              {LICENCE_TYPES.map((type) => {
                const s = o.summary.find((x) => x.type === type);
                return (
                  <Card key={type} style={styles.tile}>
                    <Text size="sm" tone="muted">
                      {t(LICENCE_TYPE_LABELS[type])}
                    </Text>
                    <Text size="xl" weight="700">
                      {s?.used ?? 0} / {s?.total ?? 0}
                    </Text>
                    <Text size="xs" tone="muted">
                      {t('{{n}} free', { n: s?.free ?? 0 })}
                      {s?.expiring ? ` · ${t('{{n}} expiring', { n: s.expiring })}` : ''}
                    </Text>
                  </Card>
                );
              })}
            </View>
            <Button title={t('Buy or renew on the web')} icon={ExternalLinkIcon} onPress={() => void Linking.openURL(`${SERVER_URL}/admin/billing`)} />

            <SectionTitle>{t('Expiring or expired')}</SectionTitle>
            {expiring.length ? (
              <Card style={{ paddingVertical: 0 }}>
                {expiring.map((s) => (
                  <View key={s.id} style={[styles.row, { borderBottomColor: c.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text weight="600">{s.subject?.name}</Text>
                      <Text size="xs" tone="muted">
                        {t(LICENCE_TYPE_LABELS[s.type])} · {t('Expires on')} {day(s.expiresAt)}
                      </Text>
                    </View>
                    <Pill label={s.status === 'EXPIRING' ? t('Expiring') : s.status === 'GRACE' ? t('In grace period') : t('Expired')} color={s.status === 'EXPIRING' ? c.warning : c.destructive} />
                  </View>
                ))}
              </Card>
            ) : (
              <Card>
                <Text tone="muted">{t('No licences expire within {{days}} days.', { days: LICENCE_EXPIRING_DAYS })}</Text>
              </Card>
            )}
          </>
        )}

        <SectionTitle>{t('Invoices')}</SectionTitle>
        {invoices.isError && <ErrorBanner message={errorMessage(invoices.error)} onRetry={refresh} />}
        {invoices.data && !invoices.data.length && <EmptyState icon={FileTextIcon} title={t('No invoices yet')} description={t('An invoice is issued and e-mailed for every payment.')} />}
        {!!invoices.data?.length && (
          <Card style={{ paddingVertical: 0 }}>
            {invoices.data.map((inv) => (
              <Pressable key={inv.id} onPress={() => share.mutate(inv)} disabled={share.isPending} style={({ pressed }) => [styles.row, { borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}>
                <View style={{ flex: 1 }}>
                  <Text weight="600">{inv.number}</Text>
                  <Text size="xs" tone="muted">
                    {day(inv.issuedAt)} · {rupees(inv.totalPaise)}
                  </Text>
                </View>
                {share.isPending && share.variables?.id === inv.id ? <ActivityIndicator /> : <FileDownIcon size={20} color={c.primary} />}
              </Pressable>
            ))}
          </Card>
        )}
        {!o && !overview.isPending && !overview.isError && <EmptyState icon={ShieldCheckIcon} title={t('No licences yet')} />}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  tile: { flexBasis: '47%', flexGrow: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
