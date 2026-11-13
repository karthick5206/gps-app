import { useLocalSearchParams } from 'expo-router';
import { BookingsScreen } from '@/features/transport/passenger/BookingsScreen';
import { routeUuid } from '@/features/transport/push-target';

export default function CommuteBookingsScreen() {
  // WP 3.9: a BOOKING_CREATED notification opens `?bookingId=<uuid>`. Deep links are untrusted: only a UUID is used, and
  // only to pick the booking out of the passenger's own list (fetched over the authenticated API).
  const { bookingId } = useLocalSearchParams<{ bookingId?: string }>();
  return <BookingsScreen focusId={routeUuid(bookingId)} />;
}
