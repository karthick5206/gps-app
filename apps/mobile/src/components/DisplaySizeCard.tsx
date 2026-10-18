import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DISPLAY_SIZES, type DisplaySize, type Me } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Card, Chips, Text } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { display, useDisplay } from '@/features/display/display';
import { api } from '@/lib/api';
import { SPACE } from '@/lib/theme';

const SIZE_LABEL: Record<DisplaySize, string> = { normal: 'Normal', large: 'Large', xlarge: 'Extra large' };

/** Text size and map icon size; saved to the profile (the web app follows it). */
export function DisplaySizeCard() {
  const { t } = useTranslation();
  const { companyId } = useAuth();
  const queryClient = useQueryClient();
  const { textSize, mapIconSize } = useDisplay();
  const save = useMutation({
    mutationFn: (prefs: { textSize?: DisplaySize; mapIconSize?: DisplaySize }) => api.patch<Me>('/auth/me/preferences', prefs),
    onSuccess: (me) => queryClient.setQueryData(meQueryKey(companyId), me),
  });
  const choose = (prefs: { textSize?: DisplaySize; mapIconSize?: DisplaySize }) => {
    display.set(prefs);
    save.mutate(prefs);
  };
  const options = DISPLAY_SIZES.map((s) => ({ value: s, label: t(SIZE_LABEL[s]) }));
  return (
    <Card style={{ gap: SPACE.md }}>
      <View style={{ gap: 6 }}>
        <Text size="sm" weight="500">
          {t('Text size')}
        </Text>
        <Chips value={textSize} onChange={(v) => choose({ textSize: v })} options={options} />
      </View>
      <View style={{ gap: 6 }}>
        <Text size="sm" weight="500">
          {t('Map icon size')}
        </Text>
        <Chips value={mapIconSize} onChange={(v) => choose({ mapIconSize: v })} options={options} />
      </View>
    </Card>
  );
}
