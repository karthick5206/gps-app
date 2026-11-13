import { CalendarIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { SPACE } from '@/lib/theme';
import { BOOKING_STATUS_META, bookingKindLabel, DIRECTION_LABEL } from '../labels';
import { isNotPassenger, transportErrorText } from '../passenger-api';
import { clockIn } from '../trip-window';
import { Line, StatusChip, TransportEmpty } from '../ui';
import { EXCEPTION_LABEL, PICKUP_MODE_LABEL, WEEKDAY_SHORT as WEEKDAY } from '../self-service';
import { isSelfBookingOff, useMyCommute } from '../self-service-api';

/**
 * My regular commute (E5 WP 5.3; doc 08 "Commute"): the schedules the transport desk set up for the passenger, their
 * upcoming leave days / changes and the bookings they made for the next two weeks. Read-only: changes go through the
 * desk (schedule change requests are a later step).
 */
export function CommuteScheduleScreen() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const q = useMyCommute();
  if (q.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(q.error) || isSelfBookingOff(q.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        {isNotPassenger(q.error) ? (
          <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
        ) : (
          <TransportEmpty title={t('Booking in the app is off')} description={t('Your company has not switched on booking in the app. Contact your transport desk.')} />
        )}
      </View>
    );
  }
  const data = q.data;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      {q.isError && <ErrorBanner message={transportErrorText(q.error)} onRetry={() => void q.refetch()} />}
      <SectionTitle>{t('Regular commute')}</SectionTitle>
      {data && data.schedules.length === 0 && <TransportEmpty icon={CalendarIcon} title={t('No regular commute')} description={t('Your transport desk has not set up a regular commute for you.')} />}
      {data?.schedules.map((s) => (
        <Card key={s.id} style={{ paddingVertical: 0 }}>
          <Line label={t('Shift')}>{s.shiftName}</Line>
          <Line label={t('Direction')}>{t(DIRECTION_LABEL[s.direction])}</Line>
          <Line label={t('Days')}>{s.days.map((d) => t(WEEKDAY[d] ?? String(d))).join(', ')}</Line>
          <Line label={t('Pickup')}>{s.stopName ?? t(PICKUP_MODE_LABEL[s.pickupMode] ?? s.pickupMode)}</Line>
          <Line label={t('Valid')}>{s.validTo ? `${s.validFrom} – ${s.validTo}` : t('From {{date}}', { date: s.validFrom })}</Line>
          {s.exceptions.length > 0 && <Line label={t('Coming up')}>{s.exceptions.map((e) => `${e.date}: ${t(EXCEPTION_LABEL[e.kind] ?? e.kind)}`).join('\n')}</Line>}
        </Card>
      ))}
      <SectionTitle>{t('Next two weeks')}</SectionTitle>
      {data && data.upcoming.length === 0 && (
        <Text size="sm" tone="muted">
          {t('No bookings in the next two weeks.')}
        </Text>
      )}
      {data?.upcoming.map((b) => {
        const meta = BOOKING_STATUS_META[b.status];
        return (
          <Card key={b.id} style={{ gap: SPACE.xs }}>
            <Text weight="600">
              {b.serviceDate} · {clockIn(b.windowStart, b.timeZone, locale)}–{clockIn(b.windowEnd, b.timeZone, locale)}
            </Text>
            <Text size="sm" tone="muted">
              {t(bookingKindLabel(b) ?? DIRECTION_LABEL[b.direction])}
            </Text>
            <StatusChip label={t(meta.label)} tone={meta.tone} />
          </Card>
        );
      })}
    </ScrollView>
  );
}
