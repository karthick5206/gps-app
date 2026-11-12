import { router } from 'expo-router';
import { AlertTriangleIcon, CheckCircle2Icon, ClockIcon, RefreshCwIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui';
import { RADIUS, SPACE, toneColors, useColors } from '@/lib/theme';
import { useDriverQueue } from '../queue-store';
import { TOUCH } from '../ui';

/**
 * Sync state of the driver's offline queue, always visible on driver screens (doc 09 §5 "sync banner"): all synced /
 * N waiting to sync / N rejected / signed-out pause / sync required. Tapping opens the Sync screen.
 */
export function SyncBanner() {
  const { t } = useTranslation();
  const c = useColors();
  const q = useDriverQueue();
  // D1b: actions the server received too late to apply (trip closed) are not "synced": the banner says so until the
  // driver dismisses them (or they are pruned after a day), so nothing disappears silently.
  const tone = q.rejected > 0 || q.syncRequired || q.paused ? 'destructive' : q.pending > 0 || q.late > 0 ? 'warning' : 'success';
  const tc = toneColors(c, tone);
  const Icon = tone === 'success' ? CheckCircle2Icon : tone === 'warning' ? ClockIcon : AlertTriangleIcon;
  const parts: string[] = [];
  if (q.pending > 0) parts.push(t('{{n}} waiting to sync', { n: q.pending }));
  if (q.rejected > 0) parts.push(t('{{n}} rejected', { n: q.rejected }));
  if (q.late > 0) parts.push(t('{{n}} not applied: trip closed', { n: q.late }));
  if (q.paused === 'AUTH') parts.push(t('Sign in again to sync'));
  if (q.paused === 'INACTIVE') parts.push(t('Sync paused: contact your dispatcher'));
  if (q.syncRequired) parts.push(t('Sync required'));
  const text = parts.length ? parts.join(' · ') : t('All actions synced');
  return (
    <Pressable
      onPress={() => router.push('/duty/sync')}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint={t('Opens the sync list')}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [{ minHeight: TOUCH, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, backgroundColor: tc.soft }, pressed && { opacity: 0.8 }]}
    >
      <Icon size={20} color={tc.text} />
      <Text weight="600" style={{ flex: 1, color: tc.text }}>
        {text}
      </Text>
      {q.syncing ? (
        <View accessibilityLabel={t('Syncing')}>
          <RefreshCwIcon size={18} color={tc.text} />
        </View>
      ) : null}
    </Pressable>
  );
}
