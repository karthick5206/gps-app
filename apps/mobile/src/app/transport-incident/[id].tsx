import { Redirect, useLocalSearchParams } from 'expo-router';
import { IncidentScreen } from '@/features/transport/incidents/IncidentScreen';
import { routeUuid } from '@/features/transport/push-target';

/** Read-only SOS incident (r114, QA B2): opened by a tapped dispatcher SOS push (etms_incidents:view). */
export default function TransportIncidentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Push payloads and deep links are untrusted (security review I1): only a UUID reaches the API path.
  const incidentId = routeUuid(id);
  if (!incidentId) return <Redirect href="/" />;
  return <IncidentScreen id={incidentId} />;
}
