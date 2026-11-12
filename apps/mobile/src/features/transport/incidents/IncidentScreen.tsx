import { useQuery } from '@tanstack/react-query';
import { SOS_ROUTES, type IncidentDetail } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { currentLocale } from '@/lib/i18n';
import { SPACE } from '@/lib/theme';
import { Line, StatusChip, TransportEmpty } from '../ui';
import { INCIDENT_EVENT_LABEL, INCIDENT_NOTIFY_LABEL, INCIDENT_RAISER_LABEL, INCIDENT_RESOLUTION_LABEL, INCIDENT_STATUS_LABEL } from './incident-labels';

const PATH = SOS_ROUTES.incidents.replace(/^\/api/, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(currentLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Read-only SOS incident (r114, QA B2): where a dispatcher's "Transport SOS" push opens on the phone, for a login with
 * `etms_incidents:view` (`GET /api/transport/incidents/:id`, the same scope as the web lane). Refreshed every 15 s.
 * Acknowledge / resolve stay on the web lane (they need a note; doc 05 §2.10). Not the full-screen siren alarm of
 * doc 09 §7.3 (deferred).
 */
export function IncidentScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const valid = UUID.test(id);
  const q = useQuery({
    queryKey: ['transport-incident', id],
    queryFn: ({ signal }) => api.get<IncidentDetail>(`${PATH}/${id}`, undefined, signal),
    enabled: valid,
    refetchInterval: 15_000,
    retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
  });
  const i = q.data;

  if (!valid || (q.isError && q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403))) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <Stack.Screen options={{ title: t('Transport SOS') }} />
        <TransportEmpty title={t('SOS not available')} description={t('This SOS was not found, or you no longer have access to it.')} />
      </View>
    );
  }
  if (q.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (q.isError || !i) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <ErrorBanner message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      </View>
    );
  }

  const status = INCIDENT_STATUS_LABEL[i.status];
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Stack.Screen options={{ title: t('Transport SOS') }} />
      <Card style={{ gap: SPACE.sm }}>
        <Text size="lg" weight="700" accessibilityRole="header">
          {t('Transport SOS')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
          <StatusChip label={t(status.label)} tone={status.tone} />
          <StatusChip label={t(INCIDENT_NOTIFY_LABEL[i.notify])} tone="info" />
        </View>
      </Card>
      <Card style={{ paddingVertical: 0 }}>
        <Line label={t('Raised by')}>{`${t(INCIDENT_RAISER_LABEL[i.raiserType])} · ${i.raiserLabel}`}</Line>
        <Line label={t('Trip')}>{i.tripLabel ?? '—'}</Line>
        <Line label={t('Vehicle')}>{i.vehiclePlate ?? '—'}</Line>
        <Line label={t('Raised at')}>{when(i.raisedAt)}</Line>
        <Line label={t('Received by VeeTrax at')}>{when(i.receivedAt)}</Line>
        {i.repeatCount > 0 ? <Line label={t('SOS pressed again')}>{t('Pressed {{count}} more times', { count: i.repeatCount })}</Line> : null}
        {i.acknowledgedAt ? <Line label={t('Acknowledged')}>{t('Acknowledged by {{name}} at {{time}}', { name: i.acknowledgedBy ?? '—', time: when(i.acknowledgedAt) })}</Line> : null}
        {i.resolvedAt ? <Line label={t('Resolved')}>{`${when(i.resolvedAt)}${i.resolution ? ` · ${t(INCIDENT_RESOLUTION_LABEL[i.resolution])}` : ''}`}</Line> : null}
        {i.note ? <Line label={t('Note')}>{i.note}</Line> : null}
        <Line label={t('Last known position')}>
          {i.lastFix ? `${i.lastFix.lat.toFixed(5)}, ${i.lastFix.lng.toFixed(5)} · ${when(i.lastFix.at)}${i.lastFix.stale ? ` · ${t('old location')}` : ''}` : t('No position with this SOS')}
        </Line>
      </Card>

      <SectionTitle>{t('Incident history')}</SectionTitle>
      <Card style={{ gap: SPACE.sm }}>
        {i.events.map((e) => (
          <View key={e.id} accessible style={{ gap: 2 }}>
            <Text weight="600">{`${t(INCIDENT_EVENT_LABEL[e.kind] ?? e.kind)} · ${when(e.at)}`}</Text>
            {e.actorLabel || e.note ? (
              <Text size="sm" tone="muted">
                {[e.actorLabel, e.resolution ? t(INCIDENT_RESOLUTION_LABEL[e.resolution]) : null, e.note].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>
        ))}
      </Card>
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('This screen is read-only. Acknowledge and resolve the SOS in VeeTrax on the web (Incidents & SOS).')}
      </Text>
    </ScrollView>
  );
}
