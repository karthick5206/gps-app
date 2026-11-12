import { SosScreen } from '@/features/transport/SosScreen';

/** Passenger SOS (r114, QA B4): one tap from every passenger screen (header button). */
export default function PassengerSosRoute() {
  return <SosScreen audience="passenger" />;
}
