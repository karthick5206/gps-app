import { Redirect, useLocalSearchParams } from 'expo-router';
import { ReportScreen } from '@/features/transport/driver/ReportScreen';
import { routeUuid } from '@/features/transport/push-target';

export default function DutyReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Deep links are untrusted (security review I1): only a UUID reaches the API path.
  const tripId = routeUuid(id);
  if (!tripId) return <Redirect href="/duty" />;
  return <ReportScreen tripId={tripId} />;
}
