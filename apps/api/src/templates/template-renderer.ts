import { MessageTemplate, PrismaClient } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertTypeCode } from '@veetracer/shared';
import { formatDuration, formatLocal } from '../alerts/logic/time-window';
import { htmlToText, isSendable, renderSms, renderText } from './render';

export type TemplateChannel = 'EMAIL' | 'SMS' | 'PUSH' | 'WHATSAPP';

export interface Rendered {
  templateId: string | null;
  subject: string | null;
  /** HTML for e-mail, plain text otherwise. */
  body: string;
  /** Plain-text alternative (e-mail) or the final SMS text. */
  text: string;
  missing: string[];
  /** SMS only. */
  dltTemplateId?: string | null;
  dltText?: string;
  dltValues?: string[];
  senderId?: string | null;
}

export function renderTemplate(t: Pick<MessageTemplate, 'id' | 'channel' | 'subject' | 'body' | 'dltTemplateId' | 'senderId'>, vars: Record<string, unknown>): Rendered {
  const subject = t.subject ? renderText(t.subject, vars).text : null;
  if (t.channel === 'EMAIL') {
    const body = renderText(t.body, vars, true);
    return { templateId: t.id, subject, body: body.text, text: htmlToText(body.text), missing: body.missing };
  }
  if (t.channel === 'SMS') {
    const sms = renderSms(t.body, vars);
    return {
      templateId: t.id,
      subject: null,
      body: sms.text,
      text: sms.text,
      missing: sms.missing,
      dltTemplateId: t.dltTemplateId,
      dltText: sms.dltText,
      dltValues: sms.values,
      senderId: t.senderId,
    };
  }
  const body = renderText(t.body, vars);
  return { templateId: t.id, subject, body: body.text, text: body.text, missing: body.missing };
}

export interface AlertVarsInput {
  type: string;
  severity: string;
  occurredAt: Date;
  lat: number | null;
  lng: number | null;
  address: string | null;
  data: Record<string, unknown>;
  geofenceName: string | null;
}

export interface AlertVarsContext {
  objectName: string;
  plateNumber: string | null;
  branchName: string | null;
  companyName: string;
  timezone: string;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Template variables for an alert (COMMON_PLACEHOLDERS + type-specific ones). */
export function alertVars(a: AlertVarsInput, c: AlertVarsContext): Record<string, string> {
  const d = a.data;
  const kph = (v: unknown) => (n(v) === null ? '' : `${Math.round(n(v)!)} km/h`);
  const coords = a.lat !== null && a.lng !== null ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : '';
  return {
    vehicle_name: c.objectName,
    plate: c.plateNumber ?? '',
    branch: c.branchName ?? '',
    alert_type: ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type,
    severity: a.severity,
    time: formatLocal(a.occurredAt.getTime(), c.timezone),
    location: a.address ?? coords,
    map_link: a.lat !== null && a.lng !== null ? `https://maps.google.com/?q=${a.lat.toFixed(6)},${a.lng.toFixed(6)}` : '',
    speed: kph(d.speedKph),
    driver_name: '—',
    company: c.companyName,
    limit: kph(d.limitKph),
    max_speed: kph(d.maxSpeedKph ?? d.speedKph),
    duration: n(d.durationSec) === null ? '' : formatDuration(n(d.durationSec)!),
    geofence: a.geofenceName ?? (typeof d.geofence === 'string' ? d.geofence : ''),
    battery: n(d.batteryPct) === null ? '' : `${Math.round(n(d.batteryPct)!)}%`,
  };
}

/**
 * Picks the template to send: the company's active override (SMS: also approved), else the active system template.
 * Plain class so the API and the notifier can share it.
 */
export class TemplateRenderer {
  constructor(private readonly prisma: PrismaClient) {}

  async pick(companyId: string | null, purpose: string, channel: TemplateChannel, language = 'en'): Promise<MessageTemplate | null> {
    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        purpose,
        channel,
        language: { in: [...new Set([language, 'en'])] },
        OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])],
      },
    });
    const rank = (t: MessageTemplate) => (t.companyId ? 2 : 0) + (t.language === language ? 1 : 0);
    return rows.filter(isSendable).sort((a, b) => rank(b) - rank(a))[0] ?? null;
  }

  async render(companyId: string | null, purpose: string, channel: TemplateChannel, vars: Record<string, unknown>): Promise<Rendered | null> {
    const t = await this.pick(companyId, purpose, channel);
    return t ? renderTemplate(t, vars) : null;
  }
}

export interface AlertContext {
  object: { id: string; companyId: string; branchId: string | null; name: string; plateNumber: string | null };
  company: { id: string; name: string; timezone: string };
  vars: Record<string, string>;
}

/** Object/company/geofence names of an alert and its template variables. */
export async function loadAlertContext(
  prisma: PrismaClient,
  alert: { companyId: string; objectId: string; type: string; severity: string; occurredAt: Date; lat: number | null; lng: number | null; address: string | null; data: unknown; geofenceId: string | null },
): Promise<AlertContext | null> {
  const [object, company, geofence] = await Promise.all([
    prisma.trackedObject.findUnique({
      where: { id: alert.objectId },
      select: { id: true, companyId: true, branchId: true, name: true, plateNumber: true, branch: { select: { name: true } } },
    }),
    prisma.company.findUnique({ where: { id: alert.companyId }, select: { id: true, name: true, timezone: true } }),
    alert.geofenceId ? prisma.geofence.findUnique({ where: { id: alert.geofenceId }, select: { name: true } }) : null,
  ]);
  if (!object || !company) return null;
  const data = typeof alert.data === 'object' && alert.data !== null && !Array.isArray(alert.data) ? (alert.data as Record<string, unknown>) : {};
  const vars = alertVars(
    { ...alert, data, geofenceName: geofence?.name ?? null },
    { objectName: object.name, plateNumber: object.plateNumber, branchName: object.branch?.name ?? null, companyName: company.name, timezone: company.timezone },
  );
  const { branch: _branch, ...rest } = object;
  return { object: rest, company, vars };
}
