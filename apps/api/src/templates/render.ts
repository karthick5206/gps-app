import { ALERT_TYPE_MAP, AlertTypeCode, COMMON_PLACEHOLDERS, SYSTEM_TEMPLATE_PURPOSES, TemplateApproval } from '@veetracer/shared';

const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

export const SYSTEM_PLACEHOLDERS: Record<(typeof SYSTEM_TEMPLATE_PURPOSES)[number], string[]> = {
  SYSTEM_OTP: ['code', 'expires_min', 'company'],
  SYSTEM_PASSWORD_RESET: ['user_name', 'reset_link', 'expires_min', 'company'],
  SYSTEM_WELCOME: ['user_name', 'login_link', 'email', 'company'],
  SYSTEM_SCHEDULED_REPORT: ['user_name', 'report_name', 'period', 'generated_at', 'file_name', 'company'],
};

export const TEMPLATE_PURPOSES: string[] = [...Object.keys(ALERT_TYPE_MAP), ...SYSTEM_TEMPLATE_PURPOSES];

/** Placeholder names available for a purpose (common + type-specific for alerts). */
export function placeholdersFor(purpose: string): string[] {
  if (purpose in SYSTEM_PLACEHOLDERS) return SYSTEM_PLACEHOLDERS[purpose as keyof typeof SYSTEM_PLACEHOLDERS];
  const def = ALERT_TYPE_MAP[purpose as AlertTypeCode];
  if (!def) return [...COMMON_PLACEHOLDERS];
  return [...COMMON_PLACEHOLDERS, ...def.placeholders.filter((p) => !(COMMON_PLACEHOLDERS as readonly string[]).includes(p))];
}

/** Placeholder names in order of first appearance. */
export function templateVariables(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const name = m[1].toLowerCase();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface RenderResult {
  text: string;
  /** Placeholders without a value (rendered as empty). */
  missing: string[];
}

/** Replace `{{name}}` with values; HTML-escapes values when `html` is set. Unknown names render empty. */
export function renderText(template: string, vars: Record<string, unknown>, html = false): RenderResult {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER_RE, (_m, raw: string) => {
    const name = raw.toLowerCase();
    const v = vars[name];
    if (v === undefined || v === null || v === '') {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    const s = String(v);
    return html ? escapeHtml(s) : s;
  });
  return { text, missing };
}

/**
 * DLT (India TRAI) form of an SMS body: every `{{name}}` occurrence becomes `{#var#}`. Variables are filled
 * positionally in the order returned by `smsVariableOrder` (one slot per occurrence).
 */
export function smsDltText(body: string): string {
  return body.replace(PLACEHOLDER_RE, '{#var#}');
}

/** One entry per `{{name}}` occurrence (repeats included), matching the `{#var#}` slots of the DLT text. */
export function smsVariableOrder(body: string): string[] {
  return [...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1].toLowerCase());
}

/** Fill a DLT text's `{#var#}` slots positionally (what an SMS gateway does with the variables list). */
export function fillDltText(dltText: string, values: string[]): string {
  let i = 0;
  return dltText.replace(/\{#var#\}/g, () => values[i++] ?? '');
}

/** Render an SMS: values per DLT slot and the final text (identical to rendering the `{{name}}` body). */
export function renderSms(body: string, vars: Record<string, unknown>): { text: string; dltText: string; values: string[]; missing: string[] } {
  const order = smsVariableOrder(body);
  const values = order.map((name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])));
  const missing = [...new Set(order.filter((_n, i) => values[i] === ''))];
  const dltText = smsDltText(body);
  return { text: fillDltText(dltText, values), dltText, values, missing };
}

/** SMS length/parts: GSM-7 160 (153 per part when concatenated), otherwise UCS-2 70 (67). */
export function smsParts(text: string): { encoding: 'GSM' | 'UNICODE'; length: number; parts: number } {
  const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  const EXT = '^{}\\[~]|€';
  let length = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM.includes(ch)) length += 1;
    else if (EXT.includes(ch)) length += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM', length, parts: length <= 160 ? 1 : Math.ceil(length / 153) };
  const ulen = [...text].length;
  return { encoding: 'UNICODE', length: ulen, parts: ulen <= 70 ? 1 : Math.ceil(ulen / 67) };
}

/**
 * SMS DLT rule: an SMS template may be active only when approved (DLT template id registered). Returns an error
 * message or null. Non-SMS channels are always fine.
 */
export function smsActivationError(t: {
  channel: string;
  isActive: boolean;
  approvalStatus: string;
  dltTemplateId: string | null;
}): string | null {
  if (t.channel !== 'SMS') return null;
  if (t.approvalStatus === 'APPROVED' && !t.dltTemplateId?.trim()) return 'An approved SMS template needs a DLT template id';
  if (t.isActive && t.approvalStatus !== 'APPROVED') return 'SMS templates can be activated only after DLT approval (status APPROVED)';
  return null;
}

/** Usable by the notifier: active, and for SMS also approved. */
export function isSendable(t: { channel: string; isActive: boolean; approvalStatus: string }): boolean {
  return t.isActive && (t.channel !== 'SMS' || t.approvalStatus === 'APPROVED');
}

export const APPROVAL_STATUSES: TemplateApproval[] = ['NA', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'];

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Sample values for previews. */
export function sampleVars(purpose: string, company = 'Demo Logistics'): Record<string, string> {
  return {
    vehicle_name: 'Truck 07',
    plate: 'TN-09-AB-1259',
    branch: 'Chennai',
    alert_type: ALERT_TYPE_MAP[purpose as AlertTypeCode]?.label ?? purpose,
    severity: 'WARNING',
    time: '18 Oct 2026, 14:05',
    location: 'Anna Salai, Chennai',
    map_link: 'https://maps.google.com/?q=13.0604,80.2496',
    speed: '72 km/h',
    driver_name: '—',
    company,
    limit: '60 km/h',
    max_speed: '84 km/h',
    duration: '12 min',
    geofence: 'Depot',
    battery: '15%',
    code: '482913',
    expires_min: '5',
    user_name: 'Priya',
    reset_link: 'https://app.veetracer.local/reset-password?token=sample',
    login_link: 'https://app.veetracer.local/login',
    email: 'priya@example.com',
    report_name: 'Daily summary',
    period: '17 Oct 2026',
    generated_at: '18 Oct 2026, 07:00',
    file_name: 'summary-2026-10-17.xlsx',
  };
}
