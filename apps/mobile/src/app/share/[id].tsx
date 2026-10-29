import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIVE_SHARE_DEFAULT_HOURS, LIVE_SHARE_MAX_HOURS, type LiveShareCreatedDto, type LiveShareDto } from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Share2Icon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Share, View } from 'react-native';
import { Button, Card, Field, Text } from '@/components/ui';
import { liveStore } from '@/features/live/live-store';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

const QUICK_HOURS = [1, 2, 4, 8, 24, 72];

/** Share a vehicle / person's live location by link (valid for the hours entered); open it in any browser. */
export default function ShareLiveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const o = liveStore.get(id);
  const name = o?.name ?? t('Vehicle');
  const [hours, setHours] = useState(String(LIVE_SHARE_DEFAULT_HOURS));
  const [note, setNote] = useState('');
  const shares = useQuery({ queryKey: ['live-shares', id], queryFn: ({ signal }) => api.get<LiveShareDto[]>('/live-shares', { objectId: id }, signal) });
  const h = Number(hours);
  const valid = Number.isInteger(h) && h >= 1 && h <= LIVE_SHARE_MAX_HOURS;

  const share = (s: LiveShareCreatedDto) =>
    Share.share({ message: t('Live location of {{name}} (valid for {{hours}} h): {{url}}', { name, hours: s.hours, url: s.url }) }).catch(() => undefined);
  const create = useMutation({
    mutationFn: () => api.post<LiveShareCreatedDto>('/live-shares', { objectId: id, hours: h, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['live-shares', id] });
      void share(s);
    },
    onError: (e) => Alert.alert(t('Could not create the link'), errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (shareId: string) => api.post<LiveShareDto>(`/live-shares/${shareId}/revoke`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['live-shares', id] }),
    onError: (e) => Alert.alert(t('Could not stop sharing'), errorMessage(e)),
  });
  const active = (shares.data ?? []).filter((s) => s.active);

  return (
    <>
      <Stack.Screen options={{ title: t('Share live location') }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} keyboardShouldPersistTaps="handled">
        <Text tone="muted" size="sm">
          {t('Anyone with the link can watch the live position, speed and status in a browser, without the app, until it expires.')}
        </Text>
        <Card style={{ gap: SPACE.md }}>
          <Text weight="600">{name}</Text>
          <Field label={t('Valid for (hours)')} hint={t('1 to {{max}} hours', { max: LIVE_SHARE_MAX_HOURS })} value={hours} onChangeText={setHours} keyboardType="number-pad" maxLength={3} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {QUICK_HOURS.map((q) => {
              const on = String(q) === hours;
              return (
                <Pressable
                  key={q}
                  onPress={() => setHours(String(q))}
                  style={{ paddingHorizontal: 12, height: 34, borderRadius: RADIUS.full, borderWidth: 1, justifyContent: 'center', borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary : 'transparent' }}
                >
                  <Text size="sm" weight="600" style={{ color: on ? c.primaryForeground : c.foreground }}>
                    {q < 24 ? t('{{n}} h', { n: q }) : t('{{n}} days', { n: q / 24 })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Field label={t('Note (optional)')} value={note} onChangeText={setNote} maxLength={200} placeholder={t('e.g. Delivery to Anna Nagar')} />
          <Button title={t('Create and share link')} icon={Share2Icon} onPress={() => create.mutate()} loading={create.isPending} disabled={!valid} />
        </Card>
        {active.length > 0 && (
          <Card style={{ gap: SPACE.sm }}>
            <Text weight="600">{t('Active links')}</Text>
            {active.map((s) => (
              <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <Text size="sm" style={{ flex: 1 }}>
                  {t('until {{time}}', { time: formatDateTime(s.expiresAt) })}
                  {s.note ? ` · ${s.note}` : ''} · {t('{{n}} views', { n: s.viewCount })}
                </Text>
                <Pressable onPress={() => revoke.mutate(s.id)} hitSlop={8}>
                  <Text size="sm" weight="600" style={{ color: c.destructive }}>
                    {t('Stop')}
                  </Text>
                </Pressable>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </>
  );
}
