import { useMutation, useQueryClient } from '@tanstack/react-query';
import { THEMES, type Me, type ThemePreference } from '@veetracer/shared';
import { CheckIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { applyThemePreference } from '@/features/theme/theme';
import { api } from '@/lib/api';
import { SPACE, useColors, useTheme } from '@/lib/theme';

/** The five colour themes, saved to the profile (the web app uses the same one). */
export function ThemePicker() {
  const c = useColors();
  const { t } = useTranslation();
  const theme = useTheme();
  const { companyId } = useAuth();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (next: ThemePreference) => api.patch<Me>('/auth/me/preferences', { theme: next }),
    onMutate: (next) => {
      const previous = theme;
      applyThemePreference(next);
      return { previous };
    },
    onSuccess: (updated) => queryClient.setQueryData(meQueryKey(companyId), updated),
    onError: (_e, _next, ctx) => ctx && applyThemePreference(ctx.previous),
  });
  return (
    <View>
      {THEMES.map((item, i) => {
        const active = item.id === theme;
        return (
          <Pressable
            key={item.id}
            onPress={() => save.mutate(item.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.row,
              i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
              pressed && { opacity: 0.6 },
            ]}
          >
            <View style={[styles.swatch, { backgroundColor: item.swatch[0], borderColor: c.border }]}>
              <View style={[styles.swatchAccent, { backgroundColor: item.swatch[1] }]} />
            </View>
            <Text weight={active ? '600' : '400'} style={{ flex: 1 }}>
              {t(item.label)}
            </Text>
            {active && <CheckIcon size={18} color={c.primary} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 12, minHeight: 48 },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  swatchAccent: { position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, borderTopLeftRadius: 14 },
});
