import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhotoFeatureKey, PhotoFeaturesDto } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { CameraIcon, ImageIcon, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Switch, View } from 'react-native';
import { Card, ErrorBanner, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const KEY = ['company-photo-features'] as const;

const ROWS: { key: PhotoFeatureKey; label: string; hint: string; icon: LucideIcon }[] = [
  { key: 'personPhotos', label: 'Person photos', hint: 'Photos of people, pets and assets: upload in the object form and the Tracker app, photo markers and the photo on hover on the maps.', icon: ImageIcon },
  { key: 'photoNotes', label: 'Photo notes', hint: 'Photos with a note and their place ("Add photo here"): the Photos & notes page and the photo-note layers on the live map and in history.', icon: CameraIcon },
];

/**
 * More → Features (administrators): the company's own photo switches, the same as Settings → Features on the web.
 * Default off; saved at once per switch; /auth/me is read again so menus and photos follow.
 */
export default function FeaturesScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<PhotoFeaturesDto>('/company/photo-features', undefined, signal) });
  const save = useMutation({
    mutationFn: (change: Partial<Record<PhotoFeatureKey, boolean>>) => api.put<PhotoFeaturesDto>('/company/photo-features', change),
    onSuccess: (res) => {
      queryClient.setQueryData(KEY, res);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => Alert.alert(t('Features'), errorMessage(err)),
  });
  const data = state.data;
  const canEdit = !!data?.canEdit;

  return (
    <>
      <Stack.Screen options={{ title: t('Features') }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={state.isRefetching} onRefresh={() => void state.refetch()} />}>
        <Text tone="muted" size="sm">
          {t('Choose which photo features this account uses. Both are off until switched on. Switching a feature off only hides it: photos and notes already saved are kept and come back when it is switched on again.')}
        </Text>
        {state.isPending && <ActivityIndicator style={{ margin: SPACE.xl }} />}
        {state.isError && <ErrorBanner message={errorMessage(state.error)} onRetry={() => void state.refetch()} />}
        {data &&
          ROWS.map(({ key, label, hint, icon: Icon }) => (
            <Card key={key}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
                <Icon size={20} color={c.mutedForeground} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text weight="600">{t(label)}</Text>
                  <Text size="xs" tone="muted">
                    {t(hint)}
                  </Text>
                </View>
                <Switch
                  value={data[key]}
                  onValueChange={(v) => save.mutate({ [key]: v })}
                  disabled={!canEdit || save.isPending}
                  trackColor={{ true: c.primary }}
                  accessibilityLabel={t(label)}
                />
              </View>
            </Card>
          ))}
        {data && !canEdit && (
          <Text size="sm" tone="muted">
            {t('Only an administrator can change these.')}
          </Text>
        )}
      </ScrollView>
    </>
  );
}
