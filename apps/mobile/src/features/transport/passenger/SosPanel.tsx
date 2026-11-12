import { PhoneIcon, RotateCcwIcon, SirenIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Button, Card, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { SPACE, toneColors, useColors } from '@/lib/theme';
import { useNow } from '../passenger-api';
import { SOS_STAGE_TEXT, type SosStageKey } from '../self-service';
import { shouldPromptCall, sosStage, type SosItem, type SosStage } from '../sos-queue';
import { passengerSos, useSosQueue, type SosChannel } from '../sos-store';
import { BigAction, StatusChip, TOUCH } from '../ui';

/** Emergency number shown next to the desk (India: 112; doc 08 §6.1). */
const EMERGENCY_NUMBER = '112';
const HOLD_MS = 2_000;

const STAGE_TEXT: Record<SosStage, (typeof SOS_STAGE_TEXT)[SosStageKey]> = SOS_STAGE_TEXT;

function dial(number: string) {
  Linking.openURL(`tel:${number.replace(/[^0-9+]/g, '')}`).catch(() => undefined);
}

function CallButtons({ deskPhone, driver }: { deskPhone: string | null; driver: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: SPACE.sm }}>
      {deskPhone ? <BigAction title={driver ? t('Call dispatcher') : t('Call transport desk')} icon={PhoneIcon} tone="info" onPress={() => dial(deskPhone)} /> : null}
      <BigAction title={t('Call emergency {{number}}', { number: EMERGENCY_NUMBER })} icon={PhoneIcon} tone="destructive" onPress={() => dial(EMERGENCY_NUMBER)} />
    </View>
  );
}

function SosStatus({ channel, item, deskPhone }: { channel: SosChannel; item: SosItem; deskPhone: string | null }) {
  const { t } = useTranslation();
  const now = useNow(5_000);
  const stage = sosStage(item);
  const meta = STAGE_TEXT[stage];
  const at = new Date(item.raisedAt).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });
  // Announce stage changes (status never only by colour, doc 08 §6.2).
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(t(meta.label));
  }, [meta.label, t]);
  return (
    <Card style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' }}>
        <Text weight="700">{t('SOS at {{time}}', { time: at })}</Text>
        <StatusChip label={t(meta.label)} tone={meta.tone} />
      </View>
      <Text size="sm" tone="muted">
        {t(meta.body)}
      </Text>
      {item.receipt?.acknowledgement ? <Text size="sm">{t('Acknowledged by {{name}}', { name: item.receipt.acknowledgement.by })}</Text> : null}
      {stage === 'UNDELIVERED' && <Button title={t('Try again')} icon={RotateCcwIcon} variant="outline" onPress={() => channel.retry(item.clientIncidentId)} style={{ minHeight: TOUCH }} />}
      {shouldPromptCall(item, now) && <CallButtons deskPhone={deskPhone} driver={channel.audience === 'driver'} />}
    </Card>
  );
}

/**
 * SOS (passenger: doc 08 §4.2 "SOS"; driver: doc 09 §7.3; doc 10 §6): hold the button for 2 seconds (a confirm step
 * instead when a screen reader is on). The SOS is saved on the phone first and sent with retries (sos-store.ts); its
 * state is shown honestly ("Not sent yet" → "Received by VeeTrax" → "Acknowledged by the desk"), never "help is on the
 * way", and the call buttons stay available. `enabled` false (the server said it has no SOS route) leaves only the call
 * buttons. `large` is the full-screen variant (a target big enough to hit in a moving vehicle).
 */
export function SosPanel({
  channel = passengerSos,
  enabled = true,
  tripId,
  deskPhone,
  large = false,
}: {
  channel?: SosChannel;
  enabled?: boolean;
  tripId: string | null;
  deskPhone: string | null;
  large?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const q = useSosQueue(channel);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => sub.remove();
  }, []);

  const send = () => {
    setError(null);
    channel.raise({ tripId }).catch(() => setError(t('Could not save the SOS on this phone. Call the desk or the emergency number now.')));
  };
  const confirmSend = () =>
    Alert.alert(t('Send SOS?'), t('The transport desk is alerted. Use it only in an emergency.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Send SOS'), style: 'destructive', onPress: send },
    ]);

  const latest = q.latest;
  const tc = toneColors(c, 'destructive');
  return (
    <View style={{ gap: SPACE.sm }}>
      {enabled ? (
        <Pressable
          onPress={screenReader ? confirmSend : undefined}
          onPressIn={() => setHolding(true)}
          onPressOut={() => setHolding(false)}
          onLongPress={screenReader ? undefined : send}
          delayLongPress={HOLD_MS}
          accessibilityRole="button"
          accessibilityLabel={t('SOS')}
          accessibilityHint={screenReader ? t('Double tap, then confirm, to alert the transport desk') : t('Hold for 2 seconds to alert the transport desk')}
          style={[styles.sos, large && styles.large, { backgroundColor: tc.solid }, holding && { opacity: 0.8 }]}
        >
          <SirenIcon size={large ? 44 : 26} color="#ffffff" />
          <Text style={{ color: '#ffffff', fontSize: large ? 24 : 18, fontWeight: '800', textAlign: 'center' }}>{holding ? t('Keep holding…') : t('Hold for SOS')}</Text>
        </Pressable>
      ) : null}
      {error ? (
        <Text size="sm" tone="destructive">
          {error}
        </Text>
      ) : null}
      {latest && enabled ? <SosStatus channel={channel} item={latest} deskPhone={deskPhone} /> : <CallButtons deskPhone={deskPhone} driver={channel.audience === 'driver'} />}
    </View>
  );
}

const styles = StyleSheet.create({
  sos: { minHeight: 64, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.lg },
  large: { minHeight: 180, flexDirection: 'column', borderRadius: 24 },
});
