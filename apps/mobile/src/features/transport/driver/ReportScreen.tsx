import { DRIVER_BREAKDOWN_REASONS, DRIVER_DELAY_REASONS, DRIVER_LIMITS } from '@veetracer/shared';
import { router } from 'expo-router';
import { SendIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { REASON_LABEL } from '../labels';
import { queueDriverEvent } from '../queue-store';
import { BigAction, TOUCH } from '../ui';
import { SyncBanner } from './SyncBanner';

function Choice<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T | null; onChange: (v: T) => void; label: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            style={{ minHeight: TOUCH, minWidth: TOUCH, paddingHorizontal: SPACE.md, justifyContent: 'center', borderRadius: RADIUS.full, borderWidth: 1, borderColor: active ? c.primary : c.border, backgroundColor: active ? c.primary : c.card }}
          >
            <Text weight={active ? '700' : '500'} style={{ color: active ? c.primaryForeground : c.foreground }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Report a delay or a breakdown (queued offline like the other trip events; doc 09 §4.4). One reason code is enough;
 * the note is optional and short (no passenger details). This form is a "no text entry while driving" screen: it is
 * reached only from the trip screen's stationary actions.
 */
export function ReportScreen({ tripId }: { tripId: string }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'REPORT_DELAY' | 'REPORT_BREAKDOWN'>('REPORT_DELAY');
  const [reason, setReason] = useState<string | null>(null);
  const [eta, setEta] = useState<number | null>(15);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasons = kind === 'REPORT_DELAY' ? DRIVER_DELAY_REASONS : DRIVER_BREAKDOWN_REASONS;
  const send = async () => {
    if (!reason) return;
    setError(null);
    try {
      await queueDriverEvent({
        tripId,
        type: kind,
        reasonCode: reason,
        etaMin: kind === 'REPORT_DELAY' ? (eta ?? undefined) : undefined,
        note: note.trim() ? note.trim().slice(0, DRIVER_LIMITS.noteMax) : undefined,
      });
      router.back();
    } catch {
      setError(t('Could not save the action on this phone. Try again.'));
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <SyncBanner />
      <Card style={{ gap: SPACE.md }}>
        <SectionTitle>{t('What happened?')}</SectionTitle>
        <Choice
          label={t('What happened?')}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setReason(null);
          }}
          options={[
            { value: 'REPORT_DELAY', label: t('Delay') },
            { value: 'REPORT_BREAKDOWN', label: t('Breakdown') },
          ]}
        />
        <SectionTitle>{t('Reason')}</SectionTitle>
        <Choice label={t('Reason')} value={reason} onChange={setReason} options={reasons.map((r) => ({ value: r, label: t(REASON_LABEL[r] ?? r) }))} />
        {kind === 'REPORT_DELAY' && (
          <>
            <SectionTitle>{t('Expected delay')}</SectionTitle>
            <Choice label={t('Expected delay')} value={eta} onChange={setEta} options={[5, 10, 15, 30, 60].map((m) => ({ value: m, label: `${m} min` }))} />
          </>
        )}
        <Field label={t('Note (optional)')} value={note} onChangeText={setNote} maxLength={DRIVER_LIMITS.noteMax} placeholder={t('No passenger names or phone numbers')} />
      </Card>
      {error && <ErrorBanner message={error} />}
      <BigAction title={t('Send report')} icon={SendIcon} onPress={() => void send()} disabled={!reason} hint={t('Saved on this phone and synced when online')} />
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('For an emergency, call your dispatcher or the emergency number.')}
      </Text>
    </ScrollView>
  );
}
