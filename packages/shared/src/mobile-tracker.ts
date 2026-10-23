/**
 * Phones running the VeeTrax Tracker app (docs/mobile-tracker/API.md). The device's uniqueId is the mobile number in
 * E.164 digits without '+', e.g. 919876543210; the phone activates with that number by OTP.
 */

/** Device-model protocol of the seeded "VeeTrax · Mobile tracker (Android)" model. */
export const MOBILE_TRACKER_PROTOCOL = 'MOBILE';

/** "+91 98765 43210", "09876543210", "9876543210" → "919876543210"; null when it isn't a mobile number. */
export function normalizeMobile(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  // Other countries: full E.164 with country code (11–15 digits; a bare 10-digit number is Indian or invalid).
  if (/^[1-9]\d{10,14}$/.test(digits) && !digits.startsWith('91')) return digits;
  return null;
}

/** "919876543210" → "+91 98765 43210" (display). */
export function formatMobile(uniqueId: string): string {
  return /^91\d{10}$/.test(uniqueId) ? `+91 ${uniqueId.slice(2, 7)} ${uniqueId.slice(7)}` : `+${uniqueId}`;
}

/** GET /devices/:id/mobile-tracker */
export interface MobileTrackerStatusDto {
  mobile: string;
  /** Pending activation code: read it out to the user when SMS isn't set up. */
  pendingCode: { code: string; expiresAt: string; smsSent: boolean; emailCount: number } | null;
  /** Extra address that gets the activation code by e-mail (device admins always get it). */
  activationEmail: string | null;
  /** Latest phones first; at most one is active. */
  sessions: { id: string; deviceName: string | null; appVersion: string | null; platform: string | null; createdAt: string; lastUsedAt: string | null; active: boolean }[];
  /** Latest phone health report (Tracker app 1.1.7+) and when it arrived. */
  health: TrackerHealth | null;
  healthAt: string | null;
}

/**
 * Phone settings reported by the Tracker app with every upload (app 1.1.7+): what decides whether tracking survives
 * in the background. `battOpt` true = the app is battery-optimised; `bucket` = Android app standby bucket
 * (10 active, 20 working set, 30 frequent, 40 rare, 45 restricted).
 */
export interface TrackerHealth {
  locOn?: boolean;
  locFine?: boolean;
  locBg?: boolean;
  battOpt?: boolean;
  powerSave?: boolean;
  dataSaver?: 'on' | 'off' | 'allowed';
  bgRestricted?: boolean;
  bucket?: number;
  notif?: boolean;
  wanted?: boolean;
  running?: boolean;
  mode?: string;
  failures?: number;
  lastError?: string;
  start?: { at: number; why: string };
  stop?: { at: number; why: string };
  refused?: { at: number; why: string };
  mfr?: string;
  model?: string;
  sdk?: number;
}

const HEALTH_BOOLS = ['locOn', 'locFine', 'locBg', 'battOpt', 'powerSave', 'bgRestricted', 'notif', 'wanted', 'running'] as const;

/** Keeps only the known keys with the right types (the payload comes from the phone). */
export function sanitizeTrackerHealth(raw: unknown): TrackerHealth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const h: TrackerHealth = {};
  for (const k of HEALTH_BOOLS) if (typeof r[k] === 'boolean') h[k] = r[k] as boolean;
  if (r.dataSaver === 'on' || r.dataSaver === 'off' || r.dataSaver === 'allowed') h.dataSaver = r.dataSaver;
  const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
  const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
  const ev = (v: unknown) => {
    if (!v || typeof v !== 'object') return undefined;
    const e = v as Record<string, unknown>;
    const at = int(e.at, 9_999_999_999_999);
    return at ? { at, why: text(e.why, 80) ?? '' } : undefined;
  };
  const set = <K extends keyof TrackerHealth>(k: K, v: TrackerHealth[K] | undefined) => {
    if (v !== undefined) h[k] = v;
  };
  set('bucket', int(r.bucket, 100));
  set('failures', int(r.failures, 1_000_000));
  set('sdk', int(r.sdk, 100));
  set('mode', text(r.mode, 20));
  set('lastError', text(r.lastError, 200));
  set('mfr', text(r.mfr, 40));
  set('model', text(r.model, 60));
  set('start', ev(r.start));
  set('stop', ev(r.stop));
  set('refused', ev(r.refused));
  return Object.keys(h).length ? h : null;
}

export type TrackerHealthIssueCode =
  | 'LOCATION_OFF'
  | 'NO_LOCATION_PERMISSION'
  | 'LOCATION_NOT_ALWAYS'
  | 'BATTERY_OPTIMISED'
  | 'POWER_SAVE'
  | 'DATA_SAVER'
  | 'BACKGROUND_RESTRICTED'
  | 'STANDBY_RESTRICTED'
  | 'UPLOADS_FAILING'
  | 'NOTIFICATIONS_OFF';

export interface TrackerHealthIssue {
  code: TrackerHealthIssueCode;
  /** error = tracking stops or can't restart; warning = may be delayed or killed. */
  severity: 'error' | 'warning';
  /** English source text (i18n key) of the problem and of the fix on the phone. */
  text: string;
  fix: string;
}

/** Problems in a phone's health report, most serious first. */
export function trackerHealthIssues(h: TrackerHealth | null | undefined): TrackerHealthIssue[] {
  if (!h) return [];
  const out: TrackerHealthIssue[] = [];
  const add = (code: TrackerHealthIssueCode, severity: 'error' | 'warning', text: string, fix: string) => out.push({ code, severity, text, fix });
  if (h.locOn === false) add('LOCATION_OFF', 'error', 'Location (GPS) is switched off on the phone', 'Turn on Location in the quick settings');
  if (h.locFine === false) add('NO_LOCATION_PERMISSION', 'error', 'The app has no location permission', 'Settings → Apps → VeeTrax Tracker → Permissions → Location → Allow all the time');
  else if (h.locBg === false)
    add('LOCATION_NOT_ALWAYS', 'error', 'Location is "Only while using the app": Android cannot restart tracking in the background', 'Settings → Apps → VeeTrax Tracker → Permissions → Location → Allow all the time');
  if (h.dataSaver === 'on') add('DATA_SAVER', 'error', 'Data Saver is on: uploads are blocked in the background', 'Settings → Network → Data Saver → allow unrestricted data for VeeTrax Tracker (or turn Data Saver off)');
  if (h.bgRestricted === true) add('BACKGROUND_RESTRICTED', 'error', 'Android restricts the app in the background', 'Settings → Apps → VeeTrax Tracker → Battery → No restrictions / Unrestricted');
  if (h.battOpt === true) add('BATTERY_OPTIMISED', 'warning', 'Battery optimisation is on for the app', 'Settings → Apps → VeeTrax Tracker → Battery saver → No restrictions');
  if (h.bucket !== undefined && h.bucket >= 40)
    add('STANDBY_RESTRICTED', 'warning', 'Android has put the app in a restricted standby group (limits background work and network)', 'Open the app once a day, and set Battery → No restrictions');
  if (h.powerSave === true) add('POWER_SAVE', 'warning', "The phone's battery saver is on", 'Turn off Battery saver in the quick settings');
  if ((h.failures ?? 0) >= 3) add('UPLOADS_FAILING', 'warning', 'Uploads are failing', 'Check mobile data / signal; the app retries automatically');
  if (h.notif === false) add('NOTIFICATIONS_OFF', 'warning', 'Notifications are off for the app (some phones then stop the tracking service)', 'Settings → Apps → VeeTrax Tracker → Notifications → On');
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
