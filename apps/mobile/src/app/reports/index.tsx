import { router, Stack } from 'expo-router';
import { ChevronRightIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { SectionList, View } from 'react-native';
import { Card, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { CATEGORY_PERMISSION, REPORT_CATEGORIES, REPORT_DEFS } from '@/features/reports/report-defs';
import { SPACE, useColors } from '@/lib/theme';

const ALL_SECTIONS = REPORT_CATEGORIES.map((category) => ({ title: category, data: REPORT_DEFS.filter((d) => d.category === category) }));

export default function ReportsScreen() {
  const { can } = useAuth();
  // Attendance reports hold people's hours and locations, planned-trip reports need planned trips: only with that permission.
  const SECTIONS = ALL_SECTIONS.map((x) => ({
    ...x,
    data: x.data.filter((d) => {
      const menu = CATEGORY_PERMISSION[d.category];
      return !menu || can(menu);
    }),
  })).filter((x) => x.data.length);
  const c = useColors();
  const { t } = useTranslation();
  return (
    <>
      <Stack.Screen options={{ title: t('Reports') }} />
      <SectionList
        sections={SECTIONS}
        keyExtractor={(d) => d.type}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm }}
        renderSectionHeader={({ section }) => <SectionTitle>{t(section.title)}</SectionTitle>}
        renderItem={({ item: d }) => (
          <Card onPress={() => router.push(`/reports/${d.type}`)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
                <d.icon size={20} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text weight="600">{t(d.label)}</Text>
                <Text size="sm" tone="muted" numberOfLines={2}>
                  {t(d.description)}
                </Text>
              </View>
              <ChevronRightIcon size={18} color={c.mutedForeground} />
            </View>
          </Card>
        )}
      />
    </>
  );
}
