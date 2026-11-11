import { Redirect, useLocalSearchParams } from 'expo-router';
import { PassengerTripScreen } from '@/features/transport/passenger/TripScreen';
import { routeUuid } from '@/features/transport/push-target';

export default function CommuteTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Deep links are untrusted (security review I1): only a UUID reaches the API path.
  const tripId = routeUuid(id);
  if (!tripId) return <Redirect href="/commute" />;
  return <PassengerTripScreen id={tripId} />;
}
