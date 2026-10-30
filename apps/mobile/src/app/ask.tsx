import { useMutation } from '@tanstack/react-query';
import { SEARCH_EXAMPLES, type SearchAnswerDto, type SearchCard } from '@veetracer/shared';
import * as WebBrowser from 'expo-web-browser';
import { router, Stack } from 'expo-router';
import { BookOpenIcon, MapPinIcon, SendIcon, SparklesIcon } from 'lucide-react-native';
import { useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Card, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SERVER_URL } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

interface Turn {
  q: string;
  a: SearchAnswerDto | null;
  error: string | null;
}

/** Answer links point at web paths; open the matching app screen. */
function openLink(href: string): void {
  const url = new URL(href, 'https://x');
  const objectId = url.searchParams.get('objectId');
  if (url.pathname === '/live') return objectId ? router.push(`/vehicle/${objectId}`) : router.push('/');
  if (url.pathname === '/history' && objectId) return router.push(`/history/${objectId}`);
  if (url.pathname === '/alerts') return router.push({ pathname: '/alerts', params: objectId ? { objectId } : {} });
  if (url.pathname === '/masters/documents') return router.push('/documents');
  if (url.pathname === '/reports') return router.push('/reports');
  router.push('/');
}

/** Ask VeeTrax: questions about your vehicles in plain words (no AI). Speak with the keyboard's microphone. */
export default function AskScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const ask = useMutation({
    mutationFn: (q: string) => api.post<SearchAnswerDto>('/ask', { q }),
    onSuccess: (a, q) => setTurns((ts) => ts.map((x) => (x.q === q && !x.a && !x.error ? { ...x, a } : x))),
    onError: (e, q) => setTurns((ts) => ts.map((x) => (x.q === q && !x.a && !x.error ? { ...x, error: errorMessage(e) } : x))),
  });
  const send = (q: string) => {
    const s = q.trim();
    if (!s) return;
    setTurns((ts) => [...ts.slice(-9), { q: s, a: null, error: null }]);
    setText('');
    ask.mutate(s);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: t('Ask VeeTrax') }} />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <SparklesIcon size={18} color={c.primary} />
          <Text size="sm" tone="muted" style={{ flex: 1 }}>
            {t('Ask about your vehicles in plain words. To speak, tap the microphone on your keyboard.')}
          </Text>
        </View>
        <Pressable onPress={() => void WebBrowser.openBrowserAsync(`${SERVER_URL}/guide#ask`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <BookOpenIcon size={16} color={c.primary} />
          <Text size="sm" weight="600" style={{ color: c.primary }}>
            {t('How to ask')}
          </Text>
        </Pressable>
        {!turns.length && <Examples onPick={send} />}
        {turns.map((turn, i) => (
          <View key={i} style={{ gap: SPACE.sm }}>
            <View style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.primary, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ color: c.primaryForeground }}>{turn.q}</Text>
            </View>
            {!turn.a && !turn.error && <ActivityIndicator style={{ alignSelf: 'flex-start' }} />}
            {turn.error && <Text style={{ color: c.destructive }}>{turn.error}</Text>}
            {turn.a && <Answer a={turn.a} onAsk={send} />}
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: SPACE.sm, padding: SPACE.md, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('e.g. Where is TN 09 BB 9421')}
          placeholderTextColor={c.mutedForeground}
          onSubmitEditing={() => send(text)}
          returnKeyType="send"
          maxLength={200}
          style={{ flex: 1, minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: 12, color: c.foreground }}
        />
        <Pressable onPress={() => send(text)} disabled={!text.trim()} accessibilityLabel={t('Ask')} style={{ width: 46, height: 46, borderRadius: RADIUS.md, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? 1 : 0.5 }}>
          <SendIcon size={20} color={c.primaryForeground} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Examples({ onPick, list = SEARCH_EXAMPLES }: { onPick: (q: string) => void; list?: readonly string[] }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {list.map((q) => (
        <Pressable key={q} onPress={() => onPick(q)} style={{ borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text size="sm">{q}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Answer({ a, onAsk }: { a: SearchAnswerDto; onAsk: (q: string) => void }) {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <Card style={{ gap: SPACE.sm }}>
      <Text>{a.answer}</Text>
      {a.cards.map((card, i) => (
        <CardView key={i} c={card} />
      ))}
      {a.choices && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {a.choices.map((ch) => (
            <Pressable key={ch.objectId} onPress={() => onAsk(ch.query)} style={{ borderWidth: 1, borderColor: c.primary, borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text size="sm" style={{ color: c.primary }}>
                {ch.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {a.examples && <Examples onPick={onAsk} list={a.examples} />}
      {a.links.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {a.links.map((l) => (
            <Pressable key={l.href} onPress={() => openLink(l.href)} style={{ backgroundColor: c.muted, borderRadius: RADIUS.md, paddingHorizontal: 10, paddingVertical: 8 }}>
              <Text size="sm" weight="600">
                {t(l.label)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

function CardView({ c: card }: { c: SearchCard }) {
  const c = useColors();
  const { t } = useTranslation();
  if (card.kind === 'location') {
    return (
      <Pressable onPress={() => router.push(`/vehicle/${card.objectId}`)} style={{ flexDirection: 'row', gap: 8, backgroundColor: c.muted, borderRadius: RADIUS.md, padding: 10 }}>
        <MapPinIcon size={18} color={c.primary} />
        <View style={{ flex: 1 }}>
          <Text size="sm" weight="600">
            {card.address ?? `${card.lat.toFixed(5)}, ${card.lng.toFixed(5)}`}
          </Text>
          <Text size="xs" tone="muted">
            {[card.status && t(card.status), card.speedKph ? `${card.speedKph} km/h` : null, card.at ? formatDateTime(card.at) : null].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Pressable>
    );
  }
  if (card.kind === 'stats') {
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {card.items.map((s) => (
          <View key={s.label} style={{ backgroundColor: c.muted, borderRadius: RADIUS.md, paddingHorizontal: 10, paddingVertical: 6, minWidth: '45%', flexGrow: 1 }}>
            <Text size="xs" tone="muted">
              {t(s.label)}
            </Text>
            <Text weight="700">{s.value}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (!card.rows.length) return null;
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: RADIUS.md }}>
      <View style={{ flexDirection: 'row', backgroundColor: c.muted, paddingHorizontal: 8, paddingVertical: 6 }}>
        {card.columns.map((h) => (
          <Text key={h} size="xs" weight="700" style={{ flex: 1 }}>
            {t(h)}
          </Text>
        ))}
      </View>
      {card.rows.slice(0, 20).map((r, i) => (
        <Pressable key={i} onPress={() => r.objectId && router.push(`/vehicle/${r.objectId}`)} style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.border }}>
          {r.cells.map((cell, j) => (
            <Text key={j} size="xs" style={{ flex: 1 }}>
              {cell}
            </Text>
          ))}
        </Pressable>
      ))}
    </View>
  );
}
