import { SosScreen } from '@/features/transport/SosScreen';

/** Driver SOS (doc 09 §7.3, r114): one tap from every driver screen (header button). */
export default function DriverSosRoute() {
  return <SosScreen audience="driver" />;
}
