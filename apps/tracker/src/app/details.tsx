import { UploadCloud } from 'lucide-react-native';
import { ScrollView, StyleSheet } from 'react-native';
import { OemCard, PermissionsCard, useChecks } from '@/components/ChecksCards';
import { Button, Card, Row } from '@/components/ui';
import { kmh, metres, timeAgo } from '@/lib/format';
import { useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { Tracker, useTrackerStatus } from '@/lib/tracking';

/** The technical picture, for when something needs checking or support asks. */
export default function DetailsScreen() {
  useStoreVersion();
  const c = useColors();
  const [checks] = useChecks();
  const [status, refreshStatus] = useTrackerStatus();
  const queued = status?.queueSize ?? 0;
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.scroll}>
      <Card>
        <Row label={S.lastFix} value={timeAgo(status?.lastFixAt ?? undefined)} />
        <Row label={S.accuracy} value={metres(status?.lastAcc)} />
        <Row label={S.speed} value={kmh(status?.lastSpd)} />
        {status?.running ? <Row label={S.mode} value={status.mode === 'stationary' ? S.modeStationary : S.modeMoving} /> : null}
        <Row label={S.waiting} value={S.points(queued)} valueColor={queued > 0 ? c.accentText : undefined} />
        <Row label={S.lastUpload} value={timeAgo(status?.lastUploadAt ?? undefined)} />
        {status && (status.droppedCount > 0 || status.mockCount > 0) ? (
          <Row label={S.filtered} value={S.filteredValue(status.droppedCount, status.mockCount)} />
        ) : null}
        {status?.lastError ? <Row label={S.uploadError} value={status.lastError} valueColor={c.danger} /> : null}
        {queued > 0 ? (
          <Button title={S.uploadNow} variant="ghost" icon={<UploadCloud color={c.muted} size={18} />} onPress={() => Tracker.flush().then(refreshStatus)} />
        ) : null}
      </Card>
      <PermissionsCard checks={checks} />
      <OemCard />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
});
