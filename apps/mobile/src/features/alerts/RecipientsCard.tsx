import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecipientEntry, RecipientListDto } from '@veetracer/shared';
import { MailIcon, MessageSquareIcon, PlusIcon, XIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Button, Card, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

type Channel = 'EMAIL' | 'SMS';
const KIND: Record<Channel, 'EMAIL' | 'MOBILE'> = { EMAIL: 'EMAIL', SMS: 'MOBILE' };
const VALID: Record<Channel, RegExp> = { EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, SMS: /^\+[1-9]\d{7,14}$/ };

/**
 * Extra email addresses / mobile numbers that receive every alert at this level (company or vehicle), on top of the
 * default recipients. Stored as the "all alerts, all severities" recipient list (mode ADD) for the channel.
 */
function ChannelRecipients({ level, targetId, channel, lists, canEdit }: { level: string; targetId: string; channel: Channel; lists: RecipientListDto[]; canEdit: boolean }) {
  const c = useColors();
  const queryClient = useQueryClient();
  const list = lists.find((l) => l.channel === channel && l.alertType === '*' && l.severity === '*') ?? null;
  const mine = (list?.entries ?? []).filter((e) => e.kind === KIND[channel]);
  const [values, setValues] = useState<string[]>(mine.map((e) => e.value));
  const [input, setInput] = useState('');
  useEffect(() => setValues(mine.map((e) => e.value)), [list?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (next: string[]) => {
      // Keep other entries of the list (users, roles…) and its mode; a new list adds to the default recipients.
      const others = (list?.entries ?? []).filter((e) => e.kind !== KIND[channel]);
      const entries: RecipientEntry[] = [...others, ...next.map((value) => ({ kind: KIND[channel], value }))];
      return api.put('/recipient-lists', { level, targetId, alertType: '*', severity: '*', channel, mode: list?.mode ?? 'ADD', entries });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recipient-lists'] }),
    onError: (err) => Alert.alert('Not saved', errorMessage(err)),
  });

  const add = () => {
    const v = channel === 'EMAIL' ? input.trim().toLowerCase() : input.replace(/[\s-]/g, '');
    if (!VALID[channel].test(v)) return Alert.alert(channel === 'EMAIL' ? 'Enter a valid email' : 'Use international format, e.g. +919876543210');
    if (values.includes(v)) return setInput('');
    const next = [...values, v];
    setValues(next);
    setInput('');
    save.mutate(next);
  };
  const removeAt = (v: string) => {
    const next = values.filter((x) => x !== v);
    setValues(next);
    save.mutate(next);
  };

  const Icon = channel === 'EMAIL' ? MailIcon : MessageSquareIcon;
  return (
    <View style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Icon size={16} color={c.primary} />
        <Text weight="600" style={{ flex: 1 }}>
          {channel === 'EMAIL' ? 'Email addresses' : 'SMS numbers'}
        </Text>
        {save.isPending && <ActivityIndicator />}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {values.length === 0 && (
          <Text size="sm" tone="muted">
            None — only the default recipients.
          </Text>
        )}
        {values.map((v) => (
          <View key={v} style={[styles.chip, { backgroundColor: c.muted }]}>
            <Text size="sm">{v}</Text>
            {canEdit && (
              <Pressable onPress={() => removeAt(v)} hitSlop={8} accessibilityLabel={`Remove ${v}`}>
                <XIcon size={14} color={c.mutedForeground} />
              </Pressable>
            )}
          </View>
        ))}
      </View>
      {canEdit && (
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={add}
            placeholder={channel === 'EMAIL' ? 'name@company.com' : '+919876543210'}
            placeholderTextColor={c.mutedForeground}
            keyboardType={channel === 'EMAIL' ? 'email-address' : 'phone-pad'}
            autoCapitalize="none"
            style={[styles.input, { borderColor: c.border, color: c.foreground, backgroundColor: c.background }]}
          />
          <Button title="Add" icon={PlusIcon} variant="outline" onPress={add} style={{ height: 42, paddingHorizontal: SPACE.md }} />
        </View>
      )}
    </View>
  );
}

export function RecipientsCard({ level, targetId, canEdit }: { level: string; targetId: string; canEdit: boolean }) {
  const lists = useQuery({
    queryKey: ['recipient-lists', level, targetId],
    queryFn: ({ signal }) => api.get<RecipientListDto[]>('/recipient-lists', { level, targetId }, signal),
  });
  return (
    <Card style={{ gap: SPACE.lg }}>
      <View style={{ gap: 2 }}>
        <Text weight="700">Extra email & SMS recipients</Text>
        <Text size="xs" tone="muted">
          Get every alert {level === 'COMPANY' ? 'for the company' : 'for this vehicle'} in addition to the default recipients (users of the vehicle and its branch). Which alerts use email or SMS is set per alert below.
        </Text>
      </View>
      {lists.isPending ? (
        <ActivityIndicator />
      ) : (
        <>
          <ChannelRecipients level={level} targetId={targetId} channel="EMAIL" lists={lists.data ?? []} canEdit={canEdit} />
          <ChannelRecipients level={level} targetId={targetId} channel="SMS" lists={lists.data ?? []} canEdit={canEdit} />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 8, paddingVertical: 5, borderRadius: RADIUS.full },
  input: { flex: 1, height: 42, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, fontSize: 15 },
});
