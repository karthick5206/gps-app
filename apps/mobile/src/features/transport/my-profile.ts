/**
 * WP 3.9 wave 2, D-A9: the passenger's own transport profile and home location (pure, `node --test`). The server owns
 * the rules (consent, own profile only, audit); these helpers shape the forms and the wording. No runtime import from
 * @veetracer/shared.
 */
import type { MeHomeLocationInput, MeTransportProfileUpdateInput } from '@veetracer/shared';

export const PROFILE_LIMITS = { contactsMax: 3, addressMax: 200, nameMax: 80, phoneMax: 20, relationMax: 40, notesMax: 300 } as const;

const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;

/** "12.9716, 77.5946" (comma, semicolon or space separated) → a valid point, or null. */
export function parseLatLng(text: string): { lat: number; lng: number } | null {
  const m = /^\s*([-+]?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** How the passenger chose the home point. */
export type HomeChoice =
  | { kind: 'SEARCH'; label: string; lat: number; lng: number }
  | { kind: 'PIN'; lat: number; lng: number; address: string }
  | { kind: 'TYPED'; text: string; address: string };

export const HOME_FORM_ERRORS = ['Enter the position as latitude, longitude, for example 12.9716, 77.5946.', 'Choose a point on the map.', 'Search an address or place first.'] as const;

/** The PUT /me/transport/home body, or the English reason it cannot be sent. */
export function homeInput(c: HomeChoice | null): { ok: true; body: MeHomeLocationInput } | { ok: false; error: string } {
  if (!c) return { ok: false, error: 'Search an address or place first.' };
  const addr = (s: string) => {
    const v = s.trim().slice(0, PROFILE_LIMITS.addressMax);
    return v ? v : null;
  };
  const valid = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (c.kind === 'SEARCH') {
    if (!valid(c.lat, c.lng)) return { ok: false, error: 'Search an address or place first.' };
    return { ok: true, body: { lat: c.lat, lng: c.lng, address: addr(c.label), source: 'PHOTON' } };
  }
  if (c.kind === 'PIN') {
    if (!valid(c.lat, c.lng)) return { ok: false, error: 'Choose a point on the map.' };
    return { ok: true, body: { lat: c.lat, lng: c.lng, address: addr(c.address), source: 'PIN' } };
  }
  const p = parseLatLng(c.text);
  if (!p) return { ok: false, error: 'Enter the position as latitude, longitude, for example 12.9716, 77.5946.' };
  return { ok: true, body: { lat: p.lat, lng: p.lng, address: addr(c.address), source: 'TYPED' } };
}

/** After a home change: open bookings keep their earlier point (D-A9). English source + count, or null when none. */
export function keptBookingsText(openBookingsKept: unknown): { text: string; count: number } | null {
  const n = typeof openBookingsKept === 'number' && Number.isFinite(openBookingsKept) ? Math.max(0, Math.floor(openBookingsKept)) : 0;
  if (n === 0) return null;
  return n === 1 ? { text: '1 existing booking keeps its earlier location.', count: 1 } : { text: '{{count}} existing bookings keep their earlier location.', count: n };
}

export interface ContactRow {
  name: string;
  phone: string;
  relation: string;
}

export const CONTACT_ERRORS = ['At most 3 emergency contacts.', 'Each contact needs a name and a phone number.', 'Check the phone number: digits, spaces and an optional + only.'] as const;

/** Emergency contacts for PATCH (blank rows dropped), or the English reason they are not valid. */
export function contactsInput(rows: readonly ContactRow[]): { ok: true; contacts: NonNullable<MeTransportProfileUpdateInput['emergencyContacts']> } | { ok: false; error: string } {
  const filled = rows.map((r) => ({ name: r.name.trim(), phone: r.phone.trim(), relation: r.relation.trim() })).filter((r) => r.name || r.phone || r.relation);
  if (filled.length > PROFILE_LIMITS.contactsMax) return { ok: false, error: 'At most 3 emergency contacts.' };
  for (const r of filled) {
    if (!r.name || !r.phone) return { ok: false, error: 'Each contact needs a name and a phone number.' };
    if (!PHONE.test(r.phone)) return { ok: false, error: 'Check the phone number: digits, spaces and an optional + only.' };
  }
  return {
    ok: true,
    contacts: filled.map((r) => ({ name: r.name.slice(0, PROFILE_LIMITS.nameMax), phone: r.phone.slice(0, PROFILE_LIMITS.phoneMax), relation: r.relation ? r.relation.slice(0, PROFILE_LIMITS.relationMax) : null })),
  };
}

/** Passenger-facing text (English source) for profile / home errors; null = the server message. */
export function profileErrorText(code: string | null | undefined): string | null {
  switch (code) {
    case 'CONSENT_REQUIRED':
      return 'Your home location is used only with your transport consent. Give it under Privacy & consent first.';
    case 'GEOCODER_NOT_PRIVATE':
      return 'Address search is not available. Place the pin on the map or type the position instead.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait and try again.';
    case 'NOT_A_PASSENGER':
      return 'Your account is not linked to an active passenger profile. Ask your transport desk.';
    case 'NOT_ELIGIBLE':
      return 'This stop cannot be used for your rides. Choose another stop.';
    default:
      return null;
  }
}

export function profileErrorStrings(): string[] {
  return ['CONSENT_REQUIRED', 'GEOCODER_NOT_PRIVATE', 'RATE_LIMITED', 'NOT_A_PASSENGER', 'NOT_ELIGIBLE'].map((c) => profileErrorText(c)!).filter(Boolean);
}
