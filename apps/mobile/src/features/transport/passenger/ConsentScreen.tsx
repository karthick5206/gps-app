import type { ConsentNoticeDto, ConsentPurpose, PassengerConsentStateDto } from '@veetracer/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Button, Card, ErrorBanner, Text } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';
import { CONSENT_PURPOSE_META } from '../labels';
import { isNotPassenger, transportErrorText, useConsentNotices, useMyConsent, useRecordConsent } from '../passenger-api';
import { StatusChip, TOUCH, TransportEmpty } from '../ui';

function statusOf(state: PassengerConsentStateDto | undefined): { label: string; tone: 'success' | 'destructive' | 'warning' } {
  if (state?.active) return { label: 'Granted', tone: 'success' };
  if (state?.revokedAt) return { label: 'Withdrawn', tone: 'destructive' };
  return { label: 'Not recorded', tone: 'warning' };
}

function PurposeCard({ purpose, notice, state }: { purpose: ConsentPurpose; notice: ConsentNoticeDto | null; state: PassengerConsentStateDto | undefined }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const record = useRecordConsent();
  const [open, setOpen] = useState(!state?.active);
  const meta = CONSENT_PURPOSE_META[purpose];
  const status = statusOf(state);
  const grant = () => notice && record.mutate({ purpose, granted: true, noticeVersion: notice.version, locale: i18n.language });
  const withdraw = () =>
    Alert.alert(t('Withdraw consent?'), t(meta.description), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Withdraw'), style: 'destructive', onPress: () => record.mutate({ purpose, granted: false, locale: i18n.language }) },
    ]);
  return (
    <Card style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Text weight="700" style={{ flex: 1 }} accessibilityRole="header">
          {t(meta.label)}
        </Text>
        <StatusChip label={t(status.label)} tone={status.tone} />
      </View>
      <Text size="sm" tone="muted">
        {t(meta.description)}
      </Text>
      {state?.active && state.grantedAt ? (
        <Text size="xs" tone="muted">
          {t('Granted on {{time}} (notice {{version}})', { time: formatDateTime(state.grantedAt), version: state.noticeVersion ?? '—' })}
        </Text>
      ) : state?.revokedAt ? (
        <Text size="xs" tone="muted">
          {t('Withdrawn on {{time}}', { time: formatDateTime(state.revokedAt) })}
        </Text>
      ) : null}

      {notice ? (
        <>
          <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
            <Text weight="600" tone="primary">
              {open ? t('Hide the notice') : t('Read the notice')}
            </Text>
          </Pressable>
          {open && (
            <View style={{ gap: SPACE.xs, borderLeftWidth: 3, borderLeftColor: c.border, paddingLeft: SPACE.md }}>
              <Text weight="600">{notice.title}</Text>
              <Text size="sm">{notice.body}</Text>
              <Text size="xs" tone="muted">
                {t('Notice {{version}}, in force since {{time}}', { version: notice.version, time: formatDateTime(notice.effectiveFrom) })}
              </Text>
            </View>
          )}
        </>
      ) : (
        <Text size="sm" tone="muted">
          {t('Your company has not published this notice yet.')}
        </Text>
      )}

      {record.isError && <ErrorBanner message={transportErrorText(record.error)} />}
      {state?.active ? (
        <Button title={t('Withdraw')} variant="outline" onPress={withdraw} loading={record.isPending} />
      ) : notice ? (
        // A grant is possible only with the notice open on screen, and names the exact version shown.
        <Button title={t('I have read the notice and agree')} onPress={grant} loading={record.isPending} disabled={!open} accessibilityHint={open ? undefined : t('Open the notice first')} />
      ) : null}
    </Card>
  );
}

/** Privacy & consent: each purpose with the company's current notice; grant or withdraw from my own session. */
export function ConsentScreen() {
  const { t } = useTranslation();
  const notices = useConsentNotices();
  const consent = useMyConsent();
  if (notices.isPending || consent.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(notices.error) || isNotPassenger(consent.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  const error = notices.error ?? consent.error;
  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}
      refreshControl={
        <RefreshControl
          refreshing={notices.isRefetching || consent.isRefetching}
          onRefresh={() => {
            void notices.refetch();
            void consent.refetch();
          }}
        />
      }
    >
      {!!error && <ErrorBanner message={transportErrorText(error)} onRetry={() => (void notices.refetch(), void consent.refetch())} />}
      <Text size="sm" tone="muted">
        {t('You decide. You can withdraw a consent at any time; your transport desk sees the change.')}
      </Text>
      {(notices.data ?? []).map((n) => (
        <PurposeCard key={n.purpose} purpose={n.purpose} notice={n.notice} state={consent.data?.find((s) => s.purpose === n.purpose)} />
      ))}
      <Text size="xs" tone="muted">
        {t('VeeTrax does not track your phone. The vehicle is shown only around your trip.')}
      </Text>
    </ScrollView>
  );
}
