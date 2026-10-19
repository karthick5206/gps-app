import * as SecureStore from 'expo-secure-store';
import { SirenIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, View } from 'react-native';
import { runEmergencyTest } from '@/components/EmergencyAlertsCard';
import { Button, Text } from '@/components/ui';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

const SEEN_KEY = 'vt.sosIntroSeen';

/** One-time "New: SOS emergency alerts" notice after the update that added the siren. */
export function SosIntroNotice() {
  const c = useColors();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(SEEN_KEY)
      .then((v) => !cancelled && !v && setOpen(true))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setOpen(false);
    SecureStore.setItemAsync(SEEN_KEY, '1').catch(() => undefined);
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: SPACE.lg }}>
        <View style={{ borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md, backgroundColor: c.card }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
            <SirenIcon size={24} color="#c62828" />
            <Text size="lg" weight="700" style={{ flex: 1 }}>
              {t('New: SOS emergency alerts')}
            </Text>
          </View>
          <Text size="sm">{t('SOS and crash alerts play a loud siren and open a full-screen alarm until someone acknowledges them.')}</Text>
          <Text size="sm" tone="muted">
            {t('You can test it any time from More → Emergency alerts.')}
          </Text>
          <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
            <Button
              title={t('Test now')}
              variant="outline"
              style={{ flex: 1 }}
              onPress={() => {
                dismiss();
                void runEmergencyTest(t);
              }}
            />
            <Button title={t('OK')} style={{ flex: 1 }} onPress={dismiss} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
