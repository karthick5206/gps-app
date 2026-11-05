import { Pressable, StyleSheet, Text, View } from 'react-native';
import { language, LANGUAGES, setLanguage } from '@/lib/language';
import { useColors } from '@/lib/theme';

/** English / हिन्दी / தமிழ், each in its own script so anyone can find theirs. */
export function LanguagePicker() {
  const c = useColors();
  const now = language();
  return (
    <View style={styles.row}>
      {LANGUAGES.map((l) => {
        const on = l.code === now;
        return (
          <Pressable
            key={l.code}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => setLanguage(l.code)}
            style={[styles.chip, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primarySoft : c.card }]}
          >
            <Text style={[styles.text, { color: on ? c.primary : c.text }]}>{l.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 18, borderRadius: 999, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 15, fontWeight: '700' },
});
