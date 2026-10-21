import { ALERT_TYPES, AlertTypeCode } from '@veetracer/shared';

export interface SystemTemplateDef {
  purpose: string;
  channel: 'EMAIL' | 'SMS' | 'PUSH';
  name: string;
  subject: string | null;
  body: string;
  approvalStatus: 'NA' | 'APPROVED';
  dltTemplateId: string | null;
  senderId: string | null;
}

/** One-line detail per alert type, shared by e-mail, SMS and push wording. */
const DETAIL: Record<AlertTypeCode, string> = {
  OVERSPEED: 'was driving at {{speed}} (limit {{limit}}, max {{max_speed}})',
  IDLING: 'has been idling for {{duration}}',
  IGNITION_ON: 'ignition was switched on',
  IGNITION_OFF: 'ignition was switched off',
  GEOFENCE_ENTER: 'entered {{geofence}}',
  GEOFENCE_EXIT: 'left {{geofence}}',
  GEOFENCE_STAY: 'has been inside {{geofence}} for {{duration}}',
  GEOFENCE_OVERSPEED: 'was driving at {{speed}} inside {{geofence}} (limit {{limit}})',
  POWER_CUT: 'tracker main power was disconnected',
  SOS: 'SOS / panic button was pressed',
  LOW_BATTERY: 'tracker battery is low ({{battery}})',
  DEVICE_OFFLINE: 'tracker has sent no data for {{duration}}',
  DEVICE_ONLINE: 'tracker is back online after {{duration}} without data',
  SIM_CHANGED: 'tracker has a different SIM card (SIM removed and another inserted)',
  GPS_LOST: 'tracker has had no GPS fix for {{duration}}',
  GSM_WEAK: 'tracker mobile signal has been weak for {{duration}}',
  DATA_DELAYED: 'tracker data is arriving {{duration}} late (network problem)',
  CLOCK_ERROR: 'tracker clock is ahead by {{duration}} (check its time zone)',
  POWER_LOW: 'vehicle battery voltage is low ({{voltage}})',
  DEVICE_TAMPER: 'tracker reported tampering or GPS jamming',
  UNKNOWN_ALARM: 'tracker sent an alarm VeeTrax does not recognise; check the device',
  DRIVER_FATIGUE: 'dashcam detected driver fatigue',
  DRIVER_PHONE: 'dashcam detected the driver using a phone',
  DRIVER_SMOKING: 'dashcam detected the driver smoking',
  DRIVER_DISTRACTED: 'dashcam detected a distracted driver',
  DRIVER_ABSENT: 'dashcam could not see a driver in the seat',
  FORWARD_COLLISION_WARNING: 'dashcam raised a forward collision warning at {{speed}}',
  LANE_DEPARTURE: 'dashcam detected a lane departure at {{speed}}',
  TAILGATING: 'was following the vehicle ahead too closely at {{speed}}',
  CAMERA_FAULT: 'dashcam reported a camera or video storage fault',
  CRASH: 'tracker detected a crash or rollover at {{speed}}',
  HARSH_ACCELERATION: 'accelerated harshly at {{speed}}',
  HARSH_BRAKING: 'braked harshly at {{speed}}',
  HARSH_CORNERING: 'cornered harshly at {{speed}}',
  DOCUMENT_EXPIRING: 'has {{document}} expiring on {{expires_on}} ({{days_left}})',
  DOCUMENT_EXPIRED: 'has {{document}} that expired on {{expires_on}}',
  SERVICE_DUE: 'is due for {{service}} {{due}}',
  FUEL_DRAIN: 'lost {{litres}} of fuel while stationary ({{fuel_before}} to {{fuel_after}}): possible fuel theft',
  FUEL_REFILL: 'was refuelled with {{litres}} ({{fuel_before}} to {{fuel_after}})',
  AC_ON: 'AC was switched on',
  AC_OFF: 'AC was switched off after {{duration}}',
  AC_ON_ENGINE_OFF: 'AC has been running with the ignition off for {{duration}}',
  DOOR_OPEN: 'door was opened',
  DOOR_CLOSED: 'door was closed after {{duration}}',
  DOOR_OPEN_WHILE_MOVING: 'door is open while driving at {{speed}}',
};

/** Reminder alerts (documents, services) have no position or speed: their e-mail shows what is due instead. */
const COMPLIANCE_ROWS: Partial<Record<AlertTypeCode, [string, string][]>> = {
  DOCUMENT_EXPIRING: [['Document', '{{document}}'], ['Expires on', '{{expires_on}} ({{days_left}})']],
  DOCUMENT_EXPIRED: [['Document', '{{document}}'], ['Expired on', '{{expires_on}}']],
  SERVICE_DUE: [['Service', '{{service}}'], ['Due', '{{due}}']],
};

const BRAND = '#0e5e57';

/** Simple responsive e-mail shell (table layout, inline styles) with the company name and an optional button. */
export function emailShell(opts: { heading: string; intro: string; rows?: [string, string][]; button?: { label: string; href: string }; footer?: string }): string {
  const rows = (opts.rows ?? [])
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 0;color:#64748b;width:120px;vertical-align:top">${k}</td><td style="padding:6px 0;color:#0f172a">${v}</td></tr>`,
    )
    .join('');
  const button = opts.button
    ? `<p style="margin:24px 0 8px"><a href="${opts.button.href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">${opts.button.label}</a></p>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${BRAND};color:#ffffff;padding:16px 20px;font-size:18px;font-weight:bold">{{company}}</td></tr>
<tr><td style="padding:20px 20px 8px">
<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">${opts.heading}</h2>
<p style="margin:0 0 12px;color:#334155;line-height:1.5">${opts.intro}</p>
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>` : ''}
${button}
</td></tr>
<tr><td style="padding:16px 20px;color:#94a3b8;font-size:12px">${opts.footer ?? 'Sent by VeeTrax on behalf of {{company}}.'}</td></tr>
</table></td></tr></table>
</body></html>`;
}

function alertEmail(code: AlertTypeCode, label: string): string {
  const compliance = COMPLIANCE_ROWS[code];
  if (compliance) {
    return emailShell({
      heading: `${label}: {{vehicle_name}}`,
      intro: `{{vehicle_name}} ${DETAIL[code]}.`,
      rows: [['Vehicle', '{{vehicle_name}} ({{plate}})'], ['Branch', '{{branch}}'], ['Severity', '{{severity}}'], ...compliance],
    });
  }
  const rows: [string, string][] = [
    ['Vehicle', '{{vehicle_name}} ({{plate}})'],
    ['Branch', '{{branch}}'],
    ['Severity', '{{severity}}'],
    ['Time', '{{time}}'],
    ['Location', '{{location}}'],
    ['Speed', '{{speed}}'],
  ];
  if (code === 'GEOFENCE_ENTER' || code === 'GEOFENCE_EXIT' || code === 'GEOFENCE_STAY' || code === 'GEOFENCE_OVERSPEED') {
    rows.splice(2, 0, ['Geofence', '{{geofence}}']);
  }
  if (code === 'FUEL_DRAIN' || code === 'FUEL_REFILL') {
    rows.splice(rows.length - 1, 1, [code === 'FUEL_DRAIN' ? 'Fuel lost' : 'Fuel added', '{{litres}}'], ['Fuel level', '{{fuel_before}} → {{fuel_after}}']);
  }
  return emailShell({
    heading: `${label}: {{vehicle_name}}`,
    intro: `{{vehicle_name}} ${DETAIL[code]}.`,
    rows,
    button: { label: 'View on map', href: '{{map_link}}' },
  });
}

let dltCounter = 0;
const nextDlt = () => `DLT-PENDING-${++dltCounter}`;

/** All system templates: every alert type × EMAIL/SMS/PUSH, plus SYSTEM_* e-mails and the OTP SMS. */
export function systemTemplates(): SystemTemplateDef[] {
  dltCounter = 0;
  const out: SystemTemplateDef[] = [];
  for (const t of ALERT_TYPES) {
    out.push({
      purpose: t.code,
      channel: 'EMAIL',
      name: `${t.label} — e-mail`,
      subject: `[{{severity}}] ${t.label}: {{vehicle_name}}`,
      body: alertEmail(t.code, t.label),
      approvalStatus: 'NA',
      dltTemplateId: null,
      senderId: null,
    });
    out.push({
      purpose: t.code,
      channel: 'SMS',
      name: `${t.label} — SMS`,
      subject: null,
      body: `{{company}}: {{vehicle_name}} {{plate}} ${DETAIL[t.code]} at {{time}}. {{map_link}} -VeeTrax`,
      approvalStatus: 'APPROVED',
      dltTemplateId: nextDlt(),
      senderId: 'VEETRC',
    });
    out.push({
      purpose: t.code,
      channel: 'PUSH',
      name: `${t.label} — push`,
      subject: `${t.label}: {{vehicle_name}}`,
      body: `{{vehicle_name}} ${DETAIL[t.code]} · {{time}}`,
      approvalStatus: 'NA',
      dltTemplateId: null,
      senderId: null,
    });
  }
  out.push({
    purpose: 'SYSTEM_OTP',
    channel: 'SMS',
    name: 'Login OTP — SMS',
    subject: null,
    body: '{{code}} is your VeeTrax login code. It expires in {{expires_min}} minutes. Do not share it with anyone. -VeeTrax',
    approvalStatus: 'APPROVED',
    dltTemplateId: nextDlt(),
    senderId: 'VEETRC',
  });
  out.push({
    purpose: 'SYSTEM_OTP',
    channel: 'EMAIL',
    name: 'Login OTP — e-mail',
    subject: 'Your VeeTrax login code: {{code}}',
    body: emailShell({
      heading: 'Your login code',
      intro: 'Use <strong style="font-size:20px;letter-spacing:2px">{{code}}</strong> to sign in. It expires in {{expires_min}} minutes. Never share this code.',
    }),
    approvalStatus: 'NA',
    dltTemplateId: null,
    senderId: null,
  });
  out.push({
    purpose: 'SYSTEM_PASSWORD_RESET',
    channel: 'EMAIL',
    name: 'Password reset — e-mail',
    subject: 'Reset your VeeTrax password',
    body: emailShell({
      heading: 'Reset your password',
      intro: 'Hi {{user_name}}, we received a request to reset your password. The link is valid for {{expires_min}} minutes and can be used once. If you did not ask for this, ignore this e-mail.',
      button: { label: 'Reset password', href: '{{reset_link}}' },
    }),
    approvalStatus: 'NA',
    dltTemplateId: null,
    senderId: null,
  });
  out.push({
    purpose: 'SYSTEM_WELCOME',
    channel: 'EMAIL',
    name: 'Welcome — e-mail',
    subject: 'Welcome to VeeTrax, {{user_name}}',
    body: emailShell({
      heading: 'Welcome to VeeTrax',
      intro: 'Hi {{user_name}}, an account has been created for you ({{email}}) at {{company}}.',
      button: { label: 'Sign in', href: '{{login_link}}' },
    }),
    approvalStatus: 'NA',
    dltTemplateId: null,
    senderId: null,
  });
  out.push({
    purpose: 'SYSTEM_SCHEDULED_REPORT',
    channel: 'EMAIL',
    name: 'Scheduled report — e-mail',
    subject: '{{report_name}} — {{period}}',
    body: emailShell({
      heading: '{{report_name}}',
      intro: 'Hi {{user_name}}, your scheduled report for {{period}} is attached ({{file_name}}).',
      rows: [['Generated', '{{generated_at}}']],
    }),
    approvalStatus: 'NA',
    dltTemplateId: null,
    senderId: null,
  });
  return out;
}
