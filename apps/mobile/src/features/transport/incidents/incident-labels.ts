/**
 * English labels of the read-only mobile incident screen (r114, QA B2). Pure (`node --test` checks hi / ta). The keys
 * are the same English strings as the web SOS lane (apps/web/src/features/transport/incidents/sos-lane.ts), so they
 * share one translation; honest wording: notify states never say "delivered".
 */
import type { IncidentRaiserType, IncidentResolution, IncidentStatus, SosNotifyState } from '@veetracer/shared';

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, { label: string; tone: 'destructive' | 'warning' | 'neutral' }> = {
  OPEN: { label: 'Open — needs acknowledgement', tone: 'destructive' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'neutral' },
};

export const INCIDENT_NOTIFY_LABEL: Record<SosNotifyState, string> = {
  QUEUED: 'Notifying dispatchers…',
  SENT_TO_DISPATCH: 'Sent to dispatchers',
  FAILED: 'Notification failed',
};

export const INCIDENT_RESOLUTION_LABEL: Record<IncidentResolution, string> = {
  ASSISTED: 'Assisted',
  FALSE_ALARM: 'False alarm',
  TEST: 'Test',
  DUPLICATE: 'Duplicate',
  OTHER: 'Other',
};

export const INCIDENT_RAISER_LABEL: Record<IncidentRaiserType, string> = {
  PASSENGER: 'Passenger',
  DRIVER: 'Driver',
  DISPATCHER: 'Dispatcher',
};

export const INCIDENT_EVENT_LABEL: Record<string, string> = {
  CREATED: 'SOS raised',
  REPEATED: 'SOS pressed again',
  NOTIFY_PUBLISHED: 'Dispatchers notified',
  NOTIFY_DIRECT: 'Dispatchers notified directly (cache down)',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

export function incidentLabelStrings(): string[] {
  return [
    ...Object.values(INCIDENT_STATUS_LABEL).map((s) => s.label),
    ...Object.values(INCIDENT_NOTIFY_LABEL),
    ...Object.values(INCIDENT_RESOLUTION_LABEL),
    ...Object.values(INCIDENT_RAISER_LABEL),
    ...Object.values(INCIDENT_EVENT_LABEL),
  ];
}
