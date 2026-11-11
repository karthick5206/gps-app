import { useLocalSearchParams } from 'expo-router';
import { ReportScreen } from '@/features/transport/driver/ReportScreen';

export default function DutyReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReportScreen tripId={id} />;
}
