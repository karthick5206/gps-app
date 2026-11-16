import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Body, Card } from '@/components/ui';
import { api, ApiError, type PhotoFeatures } from '@/lib/api';
import { handleAuthError, refreshSession } from '@/lib/control';
import { getToken } from '@/lib/state';
import { S, serverText } from '@/lib/strings';
import { useColors } from '@/lib/theme';

type Key = 'personPhotos' | 'photoNotes';

/**
 * The account's photo switches (person photos, photo notes). The owner of a personal / family account switches them
 * here; on a company phone (or a family member's phone) they are shown read-only with who can change them. Plain
 * React Native Switch: works the same on Android and iOS.
 */
export default function FeaturesScreen() {
  const c = useColors();
  const [state, setState] = useState<PhotoFeatures | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setState(await api.photoFeatures(token));
      setFailed(false);
    } catch (e) {
      if (!(await handleAuthError(e))) setFailed(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const toggle = async (key: Key, value: boolean) => {
    const token = await getToken();
    if (!token || !state) return;
    setBusy(true);
    setState({ ...state, [key]: value });
    try {
      setState(await api.setPhotoFeatures(token, { [key]: value }));
      // Home, menu and profile follow the new switches at once.
      await refreshSession(true);
    } catch (e) {
      setState(state);
      if (!(await handleAuthError(e))) Alert.alert(S.featuresTitle, e instanceof ApiError ? serverText(e.message) : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: { key: Key; label: string; hint: string }[] = [
    { key: 'personPhotos', label: S.featurePersonPhotos, hint: S.featurePersonPhotosHint },
    { key: 'photoNotes', label: S.featurePhotoNotes, hint: S.featurePhotoNotesHint },
  ];
  const readOnlyNote = state && !state.canEdit ? (state.blockedBy === 'NOT_OWNER' ? S.featuresOwnerOnly : S.featuresAskAdmin) : null;

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.scroll}>
      <Body muted>{S.featuresIntro}</Body>
      {!state && !failed ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}
      {failed && !state ? (
        <Card tone="warn">
          <Body>{S.featuresLoadFailed}</Body>
        </Card>
      ) : null}
      {state
        ? rows.map((r) => (
            <Card key={r.key}>
              <View style={styles.row}>
                <View style={styles.text}>
                  <Text style={[styles.label, { color: c.text }]}>{r.label}</Text>
                  <Text style={[styles.hint, { color: c.muted }]}>{r.hint}</Text>
                </View>
                <Switch
                  value={state[r.key]}
                  onValueChange={(v) => void toggle(r.key, v)}
                  disabled={!state.canEdit || busy}
                  trackColor={{ true: c.primary, false: c.border }}
                  accessibilityLabel={r.label}
                />
              </View>
            </Card>
          ))
        : null}
      {readOnlyNote ? <Body muted>{readOnlyNote}</Body> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 4 },
  label: { fontSize: 16, fontWeight: '700' },
  hint: { fontSize: 13 },
});
