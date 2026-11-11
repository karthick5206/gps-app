import { useLocalSearchParams } from 'expo-router';
import { DriverTripScreen } from '@/features/transport/driver/DriverTripScreen';

export default function DutyTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DriverTripScreen id={id} />;
}
