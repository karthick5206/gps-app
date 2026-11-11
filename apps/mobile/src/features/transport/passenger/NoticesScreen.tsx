import type { PassengerNoticeDto } from '@veetracer/shared';
import { BellIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { Card, ErrorBanner, Text } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { SPACE } from '@/lib/theme';
import { CONSENT_PURPOSE_META, NOTICE_KIND_LABEL } from '../labels';
import { isNotPassenger, transportErrorText, useMyNotices } from '../passenger-api';
import { TransportInbox } from '../TransportInbox';
import { PushPreferences } from './PushPreferences';
import { TransportEmpty } from '../ui';

function NoticeRow({ n }: { n: PassengerNoticeDto }) {
  const { t } = useTranslation();
  const purpose = typeof n.details.purpose === 'string' ? n.details.purpose : null;
  const purposeLabel = purpose && purpose in CONSENT_PURPOSE_META ? t(CONSENT_PURPOSE_META[purpose as keyof typeof CONSENT_PURPOSE_META].label) : purpose;
  const text = t(NOTICE_KIND_LABEL[n.kind] ?? n.kind);
  return (
    <Card style={{ gap: SPACE.xs }}>
      <View accessible accessibilityLabel={[text, purposeLabel, formatDateTime(n.createdAt)].filter(Boolean).join(', ')}>
        <Text weight="600">{text}</Text>
        {purposeLabel ? (
          <Text size="sm" tone="muted">
            {purposeLabel}
          </Text>
        ) : null}
        <Text size="xs" tone="muted">
          {formatDateTime(n.createdAt)}
        </Text>
      </View>
    </Card>
  );
}

/**
 * In-app notices (changes someone else made to my consent or login). Push messages only say that something changed;
 * this screen and the trip screens fetch the details over the authenticated API (D7).
 */
export function NoticesScreen() {
  const { t } = useTranslation();
  const q = useMyNotices();
  if (q.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(q.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  return (
    <FlatList
      data={q.data ?? []}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => <NoticeRow n={item} />}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.sm }}>
          <TransportInbox audience="passenger" />
          {q.isError ? <ErrorBanner message={transportErrorText(q.error)} onRetry={() => void q.refetch()} /> : null}
        </View>
      }
      ListFooterComponent={<View style={{ marginTop: SPACE.md }}><PushPreferences /></View>}
      ListEmptyComponent={q.isError ? undefined : <TransportEmpty icon={BellIcon} title={t('No notices')} description={t('Changes your transport desk makes to your consent or login are listed here.')} />}
    />
  );
}
