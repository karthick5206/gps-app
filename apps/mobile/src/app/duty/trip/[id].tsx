import { Redirect, useLocalSearchParams } from 'expo-router';
import { DriverTripScreen } from '@/features/transport/driver/DriverTripScreen';
import { routeUuid } from '@/features/transport/push-target';

export default function DutyTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Deep links are untrusted (security review I1): only a UUID reaches the API path.
  const tripId = routeUuid(id);
  if (!tripId) return <Redirect href="/duty" />;
  return <DriverTripScreen id={tripId} />;
}
