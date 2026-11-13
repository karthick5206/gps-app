import { MapPinIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Keyboard, Pressable, View } from 'react-native';
import { ErrorBanner, SearchInput, Text } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';
import { ADDRESS_SUGGEST, createAddressSuggest, IDLE_SUGGEST, type SuggestState } from '../address-suggest';
import { searchAddress } from '../self-service-api';
import { TOUCH } from '../ui';

export interface AddressHit {
  label: string;
  lat: number;
  lng: number;
}

/** The suggest controller bound to a component's life: state for rendering, input / reset to drive it. */
export function useAddressSuggest<T>(search: (q: string, signal: AbortSignal) => Promise<T[]>) {
  const [state, setState] = useState<SuggestState<T>>(IDLE_SUGGEST);
  const searchRef = useRef(search);
  searchRef.current = search;
  const ctl = useRef<ReturnType<typeof createAddressSuggest<T>> | null>(null);
  if (!ctl.current) ctl.current = createAddressSuggest<T>({ search: (q, s) => searchRef.current(q, s), onChange: setState });
  useEffect(() => () => ctl.current?.dispose(), []);
  return { state, input: (text: string) => ctl.current!.input(text), reset: () => ctl.current!.reset() };
}

/**
 * Address field that suggests as you type (R1151, owner request): asks the VeeTrax server (self-hosted geocoder)
 * 350 ms after typing stops, from 3 characters, one request at a time (the previous one is cancelled); the
 * suggestions list sits under the field and a tap picks one. Loading, no results and rate-limited states are shown.
 * No search button. The phone's location is never read. Used by the ride-request map point, the home location and
 * saved places.
 */
export function AddressAutocomplete<T extends AddressHit = AddressHit>({
  onPick,
  search = searchAddress as unknown as (q: string, signal: AbortSignal) => Promise<T[]>,
  initialText = '',
  errorText = errorMessage,
  onTextChange,
  testID = 'address-search',
}: {
  onPick: (hit: T) => void;
  search?: (q: string, signal: AbortSignal) => Promise<T[]>;
  initialText?: string;
  errorText?: (err: unknown) => string;
  /** Typing after a pick (the caller may forget the picked point). */
  onTextChange?: (text: string) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [text, setText] = useState(initialText);
  const { state, input, reset } = useAddressSuggest<T>(search);
  const busy = state.status === 'WAITING' || state.status === 'LOADING';
  return (
    <View style={{ gap: SPACE.xs }}>
      <SearchInput
        testID={testID}
        value={text}
        onChangeText={(v) => {
          setText(v);
          input(v);
          onTextChange?.(v);
        }}
        placeholder={t('Search an address or place')}
        accessibilityLabel={t('Search an address or place')}
        returnKeyType="done"
      />
      {state.status === 'SHORT' && (
        <Text size="xs" tone="muted">
          {t('Type at least {{n}} characters to see suggestions.', { n: ADDRESS_SUGGEST.minChars })}
        </Text>
      )}
      {busy && (
        <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center', minHeight: 32 }} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" />
          <Text size="sm" tone="muted">
            {t('Searching…')}
          </Text>
        </View>
      )}
      {state.status === 'EMPTY' && (
        <Text size="sm" tone="muted" accessibilityLiveRegion="polite">
          {t('No places found')}
        </Text>
      )}
      {state.status === 'RATE_LIMITED' && (
        <Text size="sm" tone="muted" accessibilityLiveRegion="polite" testID={`${testID}-rate-limited`}>
          {t('Too many requests. Wait a moment and try again.')}
        </Text>
      )}
      {state.status === 'ERROR' && <ErrorBanner message={errorText(state.error)} />}
      {state.status === 'DONE' && (
        <View accessibilityRole="list" accessibilityLabel={t('{{count}} suggestions', { count: state.items.length })} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.card }}>
          {state.items.map((f, i) => (
            <Pressable
              key={`${f.lat},${f.lng},${i}`}
              testID={`${testID}-suggestion-${i}`}
              onPress={() => {
                Keyboard.dismiss();
                reset();
                setText(f.label);
                onPick(f);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [
                { minHeight: TOUCH, flexDirection: 'row', gap: SPACE.sm, alignItems: 'center', paddingHorizontal: SPACE.sm, borderTopWidth: i ? 1 : 0, borderTopColor: c.border },
                pressed && { opacity: 0.6 },
              ]}
            >
              <MapPinIcon size={16} color={c.mutedForeground} />
              <Text size="sm" style={{ flex: 1 }}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
