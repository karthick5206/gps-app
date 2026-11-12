import type { MeReportCategory } from '@veetracer/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView } from 'react-native';
import { Button, Card, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { REPORT_CATEGORY_LABEL, SELF_LIMITS } from '../self-service';
import { selfServiceErrorText, useAttemptKey, useReportProblem } from '../self-service-api';
import { TOUCH } from '../ui';

const CATEGORIES = Object.keys(REPORT_CATEGORY_LABEL) as MeReportCategory[];

/**
 * Report a problem with a trip (E5 WP 5.3; doc 08 "Report"): delay, missed pickup, vehicle, driver, route or other,
 * with an optional note. Recorded on the trip for the transport desk; not an emergency channel (the SOS is on the trip
 * screen). Online only; one key per attempt so a retry is the same report.
 */
export function PassengerReportScreen({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const report = useReportProblem(tripId);
  const [key, renewKey] = useAttemptKey();
  const [category, setCategory] = useState<MeReportCategory | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Card style={{ gap: SPACE.sm }}>
          <Text weight="700" accessibilityRole="header">
            {t('Report sent')}
          </Text>
          <Text size="sm" tone="muted">
            {t('Your transport desk sees it on the trip. For an emergency use SOS or call.')}
          </Text>
        </Card>
        <Button title={t('Back to the trip')} onPress={() => router.back()} style={{ minHeight: TOUCH }} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Card>
        <Text size="sm" tone="muted">
          {t('This is not an emergency channel. In an emergency use SOS on the trip screen or call.')}
        </Text>
      </Card>
      <SectionTitle>{t('What happened?')}</SectionTitle>
      {CATEGORIES.map((k) => (
        <Pressable
          key={k}
          onPress={() => {
            if (k !== category) renewKey();
            setCategory(k);
          }}
          accessibilityRole="radio"
          accessibilityState={{ selected: category === k }}
          style={({ pressed }) => [{ minHeight: TOUCH, justifyContent: 'center', borderWidth: category === k ? 2 : 1, borderColor: category === k ? c.primary : c.border, backgroundColor: c.card, borderRadius: 12, paddingHorizontal: SPACE.md }, pressed && { opacity: 0.8 }]}
        >
          <Text weight={category === k ? '700' : '500'}>{t(REPORT_CATEGORY_LABEL[k])}</Text>
        </Pressable>
      ))}
      <Field label={t('Details (optional)')} value={note} onChangeText={setNote} maxLength={SELF_LIMITS.reportNoteMax} multiline />
      {report.isError && <ErrorBanner message={selfServiceErrorText(report.error, 'report')} />}
      <Button
        title={t('Send report')}
        disabled={!category}
        loading={report.isPending}
        onPress={() =>
          category &&
          report.mutate(
            { clientEventId: key, category, ...(note.trim() ? { note: note.trim() } : {}) },
            {
              onSuccess: () => {
                renewKey();
                setDone(true);
              },
            },
          )
        }
        style={{ minHeight: TOUCH }}
      />
    </ScrollView>
  );
}
