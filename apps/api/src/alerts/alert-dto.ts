import { Alert, NotificationLog } from '@prisma/client';
import { AlertDto, AlertTypeCode, NotificationLogDto } from '@veetracer/shared';
import { asRecord, isoOrNull } from '../common/dto';

/** Approximate cap of the `vt:notify` stream. */
export const NOTIFY_STREAM_MAXLEN = 100_000;

export interface AlertNames {
  objects: Map<string, { name: string; plateNumber: string | null; branchId: string | null }>;
  geofences: Map<string, string>;
  users: Map<string, string>;
}

export function toAlertDto(a: Alert, names: AlertNames): AlertDto {
  const o = names.objects.get(a.objectId);
  return {
    id: a.id,
    objectId: a.objectId,
    objectName: o?.name ?? 'Unknown object',
    plateNumber: o?.plateNumber ?? null,
    branchId: o?.branchId ?? null,
    type: a.type as AlertTypeCode,
    severity: a.severity,
    message: a.message,
    lat: a.lat,
    lng: a.lng,
    address: a.address,
    geofenceId: a.geofenceId,
    geofenceName: a.geofenceId ? (names.geofences.get(a.geofenceId) ?? null) : null,
    data: asRecord(a.data),
    occurredAt: a.occurredAt.toISOString(),
    status: a.status,
    ackByName: a.ackById ? (names.users.get(a.ackById) ?? null) : null,
    ackAt: isoOrNull(a.ackAt),
    ackNote: a.ackNote,
  };
}

export function toNotificationLogDto(n: NotificationLog): NotificationLogDto {
  return {
    id: n.id,
    alertId: n.alertId,
    channel: n.channel,
    recipient: n.recipient,
    subject: n.subject,
    status: n.status,
    error: n.error,
    provider: n.provider,
    createdAt: n.createdAt.toISOString(),
    sentAt: isoOrNull(n.sentAt),
  };
}
