import { RefreshCwIcon, TrashIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, View } from 'react-native';
import { Card, Text } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';
import { driverCodeText } from '../driver-api';
import type { QueuedEvent } from '../event-queue';
import { DRIVER_EVENT_LABEL } from '../labels';
import { driverQueue, syncNow, useDriverQueue } from '../queue-store';
import { BigAction, SyncBadge, TOUCH, TransportEmpty } from '../ui';

function EventRow({ e }: { e: QueuedEvent }) {
  const { t } = useTranslation();
  const c = useColors();
  const what = t(DRIVER_EVENT_LABEL[e.type] ?? e.type);
  const detail = [e.stopSeq !== undefined ? t('Stop {{n}}', { n: e.stopSeq }) : null, formatDateTime(e.occurredAt)].filter(Boolean).join(' · ');
  return (
    <Card style={{ gap: SPACE.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <View style={{ flex: 1 }} accessible accessibilityLabel={`${what}, ${detail}`}>
          <Text weight="600">{what}</Text>
          <Text size="xs" tone="muted">
            {detail}
          </Text>
        </View>
        <SyncBadge state={e.state} code={e.state === 'REJECTED' ? e.code : null} />
      </View>
      {e.state !== 'PENDING' && e.code ? (
        <Text size="sm" tone={e.state === 'REJECTED' ? 'destructive' : 'muted'}>
          {driverCodeText(e.code)}
        </Text>
      ) : null}
      {e.state === 'PENDING' && e.attempts > 0 ? (
        <Text size="xs" tone="muted">
          {t('Tried {{n}} times; trying again automatically.', { n: e.attempts })}
          {e.code ? ` ${driverCodeText(e.code)}` : ''}
        </Text>
      ) : null}
      {e.state !== 'PENDING' && (
        <Pressable
          onPress={() => void driverQueue.dismiss(e.clientEventId)}
          accessibilityRole="button"
          accessibilityLabel={t('Remove from this list')}
          style={{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs }}
        >
          <TrashIcon size={16} color={c.mutedForeground} />
          <Text size="sm" tone="muted">
            {t('Remove from this list')}
          </Text>
        </Pressable>
      )}
    </Card>
  );
}

/**
 * Everything the phone still holds for the driver: pending (waiting for the network, never shown as done), rejected
 * (with the reason; never retried) and received-late events. Pending events cannot be removed by hand.
 */
export function SyncScreen() {
  const { t } = useTranslation();
  const q = useDriverQueue();
  const next = q.nextAttemptAt ? new Date(q.nextAttemptAt).toLocaleTimeString() : null;
  return (
    <FlatList
      data={[...q.events].reverse()}
      keyExtractor={(e) => e.clientEventId}
      renderItem={({ item }) => <EventRow e={item} />}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
      ListHeaderComponent={
        <View style={{ gap: SPACE.sm, marginBottom: SPACE.sm }}>
          <Card style={{ gap: SPACE.xs }}>
            <Text weight="700" accessibilityRole="header">
              {q.pending > 0 ? t('{{n}} waiting to sync', { n: q.pending }) : t('All actions synced')}
            </Text>
            {q.paused === 'AUTH' && <Text size="sm">{t('Sign in again with the same account to send them.')}</Text>}
            {q.paused === 'INACTIVE' && <Text size="sm">{t('Sync paused: contact your dispatcher')}</Text>}
            {q.syncRequired && <Text size="sm" tone="destructive">{t('Many actions are waiting. Connect to the internet to sync.')}</Text>}
            {next && q.pending > 0 && <Text size="xs" tone="muted">{t('Next automatic try at {{time}}', { time: next })}</Text>}
            {q.lastConfirmedAt && <Text size="xs" tone="muted">{t('Last confirmed by the server at {{time}}', { time: new Date(q.lastConfirmedAt).toLocaleTimeString() })}</Text>}
          </Card>
          <BigAction title={q.syncing ? t('Syncing…') : t('Sync now')} icon={RefreshCwIcon} onPress={syncNow} disabled={q.syncing || q.pending === 0 || q.paused === 'AUTH'} />
        </View>
      }
      ListEmptyComponent={<TransportEmpty title={t('Nothing to sync')} description={t('Actions you take offline wait here until the server confirms them.')} />}
    />
  );
}
