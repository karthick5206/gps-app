import { router } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button } from '@/components/ui';
import { beginTracking } from '@/lib/control';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';

/**
 * Prominent disclosure (Google Play User Data policy) shown before the system location dialogs:
 * what is collected, that it happens in the background when the app is closed, why, and how to stop.
 */
export default function DisclosureScreen() {
  const c = useColors();
  const [busy, setBusy] = useState(false);

  const agree = async () => {
    setBusy(true);
    const r = await beginTracking().catch((e: unknown) => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (router.canGoBack()) router.back();
    if (!r.ok) Alert.alert(S.disclosureTitle, r.message);
    else if (r.backgroundDenied) Alert.alert(S.permBackground, S.permDeniedBackground);
  };

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.icon, { backgroundColor: c.primarySoft }]}>
          <MapPin color={c.primary} size={40} />
        </View>
        <Text style={[styles.heading, { color: c.text }]}>{S.disclosureTitle}</Text>
        {S.disclosureBody.map((p) => (
          <Body key={p}>{p}</Body>
        ))}
        <View style={[styles.hint, { backgroundColor: c.accentSoft, borderColor: c.accent }]}>
          <Body style={{ color: c.accentText, fontWeight: '600' }}>{S.disclosureNext}</Body>
        </View>
      </ScrollView>
      <View style={styles.actions}>
        <Button title={S.disclosureAgree} onPress={agree} busy={busy} />
        <Button title={S.disclosureCancel} variant="ghost" onPress={() => router.back()} disabled={busy} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 24, gap: 14 },
  icon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  heading: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  hint: { borderWidth: 1, borderRadius: 12, padding: 12 },
  actions: { padding: 16, gap: 8 },
});
