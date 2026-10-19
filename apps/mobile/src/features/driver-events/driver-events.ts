import { ALERT_TYPE_MAP, type AlertSeverity, type AlertTypeCode, type DriverEventStatus } from '@veetracer/shared';
import { SERVER_URL } from '@/lib/config';

/** Media URLs from the API are relative (`/api/driver-events/media/<id>?token=…`) and carry their own signed token. */
export const mediaUri = (url: string): string => (/^https?:\/\//.test(url) ? url : `${SERVER_URL}${url}`);

export const eventSeverity = (type: string): AlertSeverity => ALERT_TYPE_MAP[type as AlertTypeCode]?.defaultSeverity ?? 'WARNING';
export const eventLabel = (type: string): string => ALERT_TYPE_MAP[type as AlertTypeCode]?.label ?? type;

export const STATUS_LABEL: Record<DriverEventStatus, string> = { NEW: 'New', REVIEWED: 'Reviewed', DISMISSED: 'Dismissed', COACHED: 'Coached' };
export const STATUS_COLOR: Record<DriverEventStatus, string> = { NEW: '#2563eb', REVIEWED: '#16a34a', DISMISSED: '#6b7280', COACHED: '#7c3aed' };

/** Web video page (recordings ± 2 min around the event), opened in the browser like the vehicle Video button. */
export const videoUrl = (objectId: string, at: string): string => `${SERVER_URL}/video?objectId=${encodeURIComponent(objectId)}&at=${encodeURIComponent(at)}`;
