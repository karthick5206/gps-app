import { router, Stack } from 'expo-router';
import { ChevronRightIcon } from 'lucide-react-native';
import { SectionList, View } from 'react-native';
import { Card, SectionTitle, Text } from '@/components/ui';
import { REPORT_CATEGORIES, REPORT_DEFS } from '@/features/reports/report-defs';
import { SPACE, useColors } from '@/lib/theme';

const SECTIONS = REPORT_CATEGORIES.map((category) => ({ title: category, data: REPORT_DEFS.filter((d) => d.category === category) }));

export default function ReportsScreen() {
  const c = useColors();
  return (
    <>
      <Stack.Screen options={{ title: 'Reports' }} />
      <SectionList
        sections={SECTIONS}
        keyExtractor={(d) => d.type}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm }}
        renderSectionHeader={({ section }) => <SectionTitle>{section.title}</SectionTitle>}
        renderItem={({ item: d }) => (
          <Card onPress={() => router.push(`/reports/${d.type}`)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
                <d.icon size={20} color={c.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text weight="600">{d.label}</Text>
                <Text size="sm" tone="muted" numberOfLines={2}>
                  {d.description}
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
