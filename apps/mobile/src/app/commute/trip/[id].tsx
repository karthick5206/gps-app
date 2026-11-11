import { useLocalSearchParams } from 'expo-router';
import { PassengerTripScreen } from '@/features/transport/passenger/TripScreen';

export default function CommuteTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PassengerTripScreen id={id} />;
}
