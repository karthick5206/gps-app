import { router } from 'expo-router';
import { Activity, LogOut, PowerOff, UserRound, type LucideIcon } from 'lucide-react-native';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deactivate as deactivatePhone } from '@/lib/control';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import type { TrackerStatus } from '@/lib/tracking';

export const WEB_URL = 'https://app.veetrax.com';

/**
 * Sign out = deactivate this phone (tracking stops, a new code is needed). A phone whose company requires tracking
 * can't be signed out here; unsent points are mentioned so they aren't lost by surprise.
 */
export function confirmDeactivate(status: TrackerStatus | null, title: string = S.signOutConfirmTitle) {
  const queued = status?.queueSize ?? 0;
  if (status?.required) return Alert.alert(S.requiredTitle, S.requiredBody);
  Alert.alert(title, queued > 0 ? `${S.signOutConfirmBody}\n\n${S.signOutUnsent(queued)}` : S.signOutConfirmBody, [
    { text: S.cancel, style: 'cancel' },
    { text: S.ok, style: 'destructive', onPress: () => void deactivatePhone() },
  ]);
}

function Item({ icon: Icon, label, danger, onPress }: { icon: LucideIcon; label: string; danger?: boolean; onPress: () => void }) {
  const c = useColors();
  const color = danger ? c.danger : c.text;
  return (
    <Pressable accessibilityRole="menuitem" onPress={onPress} style={({ pressed }) => [styles.item, pressed && { backgroundColor: c.divider }]}>
      <Icon color={danger ? c.danger : c.muted} size={20} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** The menu behind the top-right icon on the home screen: Profile, Details, sign out, deactivate. Delete account is on Profile. */
export function HomeMenu({ open, onClose, status }: { open: boolean; onClose: () => void; status: TrackerStatus | null }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={S.cancel}>
        <View accessibilityRole="menu" style={[styles.card, { top: insets.top + 64, backgroundColor: c.card, borderColor: c.border }]}>
          <Item icon={UserRound} label={S.profileTitle} onPress={go(() => router.push('/profile'))} />
          <Item icon={Activity} label={S.detailsTitle} onPress={go(() => router.push('/details'))} />
          <View style={[styles.divider, { backgroundColor: c.divider }]} />
          {/* Both end this phone's session: tracking stops and a new code is needed to come back. */}
          <Item icon={LogOut} label={S.signOutShort} onPress={go(() => confirmDeactivate(status, `${S.signOutShort}?`))} />
          <Item icon={PowerOff} label={S.deactivatePhone} onPress={go(() => confirmDeactivate(status))} />
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  card: { position: 'absolute', right: 12, minWidth: 240, maxWidth: 320, borderWidth: 1, borderRadius: 12, paddingVertical: 6, elevation: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 16 },
  label: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  divider: { height: 1, marginVertical: 4 },
});
