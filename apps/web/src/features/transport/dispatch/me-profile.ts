/**
 * D-A9 (pure, `node --test`): the passenger's own transport profile on the web "My commute" page. View
 * (GET /me/transport/profile), edit default stop / emergency contacts / accessibility (PATCH /me/transport/profile) and
 * the home location (PUT /me/transport/home) by self-hosted address search, map pin or typed lat / lng. The home needs
 * the active routing consent (server: 409 CONSENT_REQUIRED). Email / mobile are identity and read-only. Field limits not
 * named by the contract are conservative client guesses; the server stays the authority.
 */
import type { MeHomeLocationInput, MeTransportProfileDto, MeTransportProfileUpdateInput } from '@veetracer/shared';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

export const ME_PROFILE_LIMITS = {
  contactsMax: 3,
  nameMax: 80,
  phoneMax: 20,
  relationMax: 40,
  notesMax: 500,
  addressMax: 200,
} as const;

export interface ContactDraft {
  name: string;
  phone: string;
  relation: string;
}

export interface ProfileDraft {
  defaultStopId: string | null;
  contacts: ContactDraft[];
  wheelchair: boolean;
  notes: string;
}

export function profileDraftOf(p: Pick<MeTransportProfileDto, 'defaultStop' | 'emergencyContacts' | 'accessibility'>): ProfileDraft {
  return {
    defaultStopId: p.defaultStop?.id ?? null,
    contacts: p.emergencyContacts.map((c) => ({ name: c.name, phone: c.phone, relation: c.relation ?? '' })),
    wheelchair: p.accessibility?.wheelchair === true,
    notes: p.accessibility?.notes ?? '',
  };
}

export const emptyContact = (): ContactDraft => ({ name: '', phone: '', relation: '' });

const PHONE = /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/;

export type ProfileErrors = { contacts?: string; notes?: string; contact?: Record<number, { name?: string; phone?: string; relation?: string }> };

export function validateProfile(d: ProfileDraft, t: Translate = english): ProfileErrors {
  const e: ProfileErrors = {};
  if (d.contacts.length > ME_PROFILE_LIMITS.contactsMax) e.contacts = t('At most {{n}} emergency contacts.', { n: ME_PROFILE_LIMITS.contactsMax });
  d.contacts.forEach((c, i) => {
    const ce: { name?: string; phone?: string; relation?: string } = {};
    const blank = !c.name.trim() && !c.phone.trim() && !c.relation.trim();
    if (blank) return; // an empty row is dropped on save
    if (!c.name.trim()) ce.name = t('Required');
    else if (c.name.trim().length > ME_PROFILE_LIMITS.nameMax) ce.name = t('At most {{n}} characters.', { n: ME_PROFILE_LIMITS.nameMax });
    if (!c.phone.trim()) ce.phone = t('Required');
    else if (!PHONE.test(c.phone.trim())) ce.phone = t('Enter a phone number (digits, optionally starting with +).');
    if (c.relation.trim().length > ME_PROFILE_LIMITS.relationMax) ce.relation = t('At most {{n}} characters.', { n: ME_PROFILE_LIMITS.relationMax });
    if (Object.keys(ce).length) (e.contact ??= {})[i] = ce;
  });
  if (d.notes.length > ME_PROFILE_LIMITS.notesMax) e.notes = t('At most {{n}} characters.', { n: ME_PROFILE_LIMITS.notesMax });
  return e;
}

export const hasProfileErrors = (e: ProfileErrors) => !!(e.contacts || e.notes || (e.contact && Object.keys(e.contact).length));

/** The PATCH body: only what changed; null when nothing changed. Blank contact rows are dropped. */
export function buildProfileUpdate(d: ProfileDraft, p: Pick<MeTransportProfileDto, 'defaultStop' | 'emergencyContacts' | 'accessibility'>): MeTransportProfileUpdateInput | null {
  const out: MeTransportProfileUpdateInput = {};
  if (d.defaultStopId !== (p.defaultStop?.id ?? null)) out.defaultStopId = d.defaultStopId;
  const contacts = d.contacts
    .filter((c) => c.name.trim() || c.phone.trim() || c.relation.trim())
    .map((c) => ({ name: c.name.trim(), phone: c.phone.trim(), relation: c.relation.trim() || null }));
  const before = p.emergencyContacts.map((c) => ({ name: c.name, phone: c.phone, relation: c.relation ?? null }));
  if (JSON.stringify(contacts) !== JSON.stringify(before)) out.emergencyContacts = contacts;
  const notes = d.notes.trim() || null;
  if (d.wheelchair !== (p.accessibility?.wheelchair === true) || notes !== (p.accessibility?.notes?.trim() || null)) out.accessibility = { wheelchair: d.wheelchair, notes };
  return Object.keys(out).length ? out : null;
}

// ───────────────────────────── Home location ─────────────────────────────

export type HomeSource = 'PHOTON' | 'PIN' | 'TYPED';

export interface HomeDraft {
  point: { lat: number; lng: number } | null;
  address: string;
  source: HomeSource | null;
  /** Typed coordinates ("12.9716"), applied with "Use these coordinates". */
  latText: string;
  lngText: string;
}

export function homeDraftOf(p: Pick<MeTransportProfileDto, 'home'>): HomeDraft {
  const h = p.home;
  const point = h && h.lat !== null && h.lng !== null ? { lat: h.lat, lng: h.lng } : null;
  return { point, address: h?.address ?? '', source: null, latText: point ? String(point.lat) : '', lngText: point ? String(point.lng) : '' };
}

/** Typed lat / lng → a point, or an error text. Up to 6 decimals; India-wide checks are left to the server. */
export function parseLatLng(latText: string, lngText: string, t: Translate = english): { lat: number; lng: number } | { error: string } {
  const num = /^-?\d{1,3}(\.\d{1,8})?$/;
  if (!num.test(latText.trim()) || !num.test(lngText.trim())) return { error: t('Enter latitude and longitude as decimal numbers (e.g. 12.9716, 77.5946).') };
  const lat = Number(latText.trim());
  const lng = Number(lngText.trim());
  if (lat < -90 || lat > 90) return { error: t('Latitude must be between -90 and 90.') };
  if (lng < -180 || lng > 180) return { error: t('Longitude must be between -180 and 180.') };
  if (lat === 0 && lng === 0) return { error: t('That is not a real location.') };
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

export function validateHome(d: HomeDraft, consent: boolean, t: Translate = english): string | undefined {
  if (!consent) return t('Your transport consent is needed before a home location can be saved.');
  if (!d.point || !d.source) return t('Search your address, click the map or type coordinates first.');
  if (d.address.trim().length > ME_PROFILE_LIMITS.addressMax) return t('At most {{n}} characters.', { n: ME_PROFILE_LIMITS.addressMax });
  return undefined;
}

/** The PUT body. Only call when `validateHome` found nothing. */
export function buildHomeInput(d: HomeDraft): MeHomeLocationInput {
  return { lat: d.point!.lat, lng: d.point!.lng, address: d.address.trim() || null, source: d.source! };
}

/** The message after a save: how many open bookings keep their earlier point. */
export function homeSavedText(openBookingsKept: number, t: Translate = english): string {
  if (openBookingsKept <= 0) return t('Home location saved. New bookings use it.');
  return t('Home location saved. New bookings use it; {{n}} booking(s) already made keep their earlier pickup. Ask the transport desk to change them.', { n: openBookingsKept });
}

/** How the home was set, for the profile view. */
export const HOME_SOURCE_LABEL: Record<string, string> = { PHOTON: 'Address search', PIN: 'Map pin', TYPED: 'Typed coordinates' };
