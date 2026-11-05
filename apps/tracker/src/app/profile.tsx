import { LogOut } from 'lucide-react-native';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LanguagePicker } from '@/components/LanguagePicker';
import { Body, Button, Card, Row } from '@/components/ui';
import { deactivate as deactivatePhone } from '@/lib/control';
import { store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { useTrackerStatus } from '@/lib/tracking';

const WEB_URL = 'https://app.veetrax.com';
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Whose phone this is, the licence, the legal pages and signing out. */
export default function ProfileScreen() {
  useStoreVersion();
  const c = useColors();
  const [status] = useTrackerStatus();
  const session = store.session();
  const required = !!status?.required;
  const queued = status?.queueSize ?? 0;

  const deactivate = () =>
    required ? Alert.alert(S.requiredTitle, S.requiredBody) : Alert.alert(S.signOutConfirmTitle, queued > 0 ? `${S.signOutConfirmBody}\n\n${S.signOutUnsent(queued)}` : S.signOutConfirmBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.ok, style: 'destructive', onPress: () => void deactivatePhone() },
    ]);

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.scroll}>
      {session ? (
        <Card>
          <Row label={S.trackingFor} value={session.objectName || `+${session.uniqueId}`} />
          <Row label={S.mobile} value={session.mobile || `+${session.uniqueId}`} />
          {session.email ? <Row label={S.email} value={session.email} /> : null}
          {session.accountType ? <Row label={S.accountType} value={S.accountTypes[session.accountType] ?? session.accountType} /> : null}
          <Row label={S.company} value={session.companyName || '—'} />
          {session.trialEndsAt ? (
            <Row label={S.freeTrialUntil} value={dateOnly(session.trialEndsAt)} />
          ) : session.licenceEndsAt ? (
            <Row label={S.licenceUntil} value={dateOnly(session.licenceEndsAt)} />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Body style={{ fontWeight: '700' }}>{S.languageTitle}</Body>
        <LanguagePicker />
      </Card>

      <View style={styles.legal}>
        <Text style={[styles.legalLink, { color: c.muted }]} onPress={() => Linking.openURL(`${WEB_URL}/privacy`).catch(() => undefined)}>
          {S.privacyPolicy}
        </Text>
        <Text style={[styles.legalLink, { color: c.muted }]} onPress={() => Linking.openURL(`${WEB_URL}/delete-account`).catch(() => undefined)}>
          {S.deleteAccount}
        </Text>
      </View>

      <Button title={S.signOut} variant="ghost" icon={<LogOut color={c.muted} size={18} />} onPress={deactivate} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  legal: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, columnGap: 20, marginTop: 4 },
  legalLink: { fontSize: 13, textDecorationLine: 'underline' },
});
