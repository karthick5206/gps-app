/**
 * ETMS E1b request context (pure, no React / DOM / aliases, so `node --test` runs it): the customer picker's URL param
 * and request header (docs/employee-transport/07 §2.5) and the Super Admin's access reason (10 §2.2 item 8).
 */
import { ACCESS_REASON_HEADER, ACCESS_REASON_MAX, ACCESS_REASON_MIN, TRANSPORT_CUSTOMER_HEADER, TRANSPORT_CUSTOMER_QUERY } from '@veetracer/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** API paths (below /api) that belong to the transport module. */
export function isTransportApiPath(path: string): boolean {
  return path === '/transport' || path.startsWith('/transport/') || path.startsWith('/transport?');
}

/** The selected customer company in a location search (`?customer=<uuid>`), or null (= all customers / invalid). */
export function customerFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get(TRANSPORT_CUSTOMER_QUERY)?.trim() ?? '';
  return UUID.test(v) ? v.toLowerCase() : null;
}

/** The search string with the customer set (or removed for null), other params kept. Returns '' or '?…'. */
export function withCustomerParam(search: string, customerId: string | null): string {
  const p = new URLSearchParams(search);
  if (customerId) p.set(TRANSPORT_CUSTOMER_QUERY, customerId);
  else p.delete(TRANSPORT_CUSTOMER_QUERY);
  // A page change in a list belongs to the previous customer's rows.
  p.delete('page');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Extra headers for one API request: the selected customer on /transport/* calls made while the page (location) is a
 * transport page carrying `?customer=`, and the remembered Super Admin reason on passenger calls.
 */
export function transportRequestHeaders(apiPath: string, location: { pathname: string; search: string } | null, rememberedReason: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isTransportApiPath(apiPath)) return out;
  // QA B1 (safety): the SOS / incident calls (lane, banner, bell, siren) are never narrowed by the customer picker.
  if (location && location.pathname.startsWith('/transport') && !isIncidentApiPath(apiPath)) {
    const customer = customerFromSearch(location.search);
    if (customer) out[TRANSPORT_CUSTOMER_HEADER] = customer;
  }
  if (rememberedReason && accessReasonApplies(apiPath)) out[ACCESS_REASON_HEADER] = encodeURIComponent(rememberedReason);
  return out;
}

/** The SOS / incident lane API (never narrowed to one customer). */
export function isIncidentApiPath(path: string): boolean {
  return path === '/transport/incidents' || path.startsWith('/transport/incidents/') || path.startsWith('/transport/incidents?');
}

/** API sections whose responses carry passenger personal data (server: requireSupportReason / @PassengerData). */
const PASSENGER_DATA_SECTIONS = ['/transport/passengers', '/transport/schedules', '/transport/bookings', '/transport/dispatch', '/transport/trips', '/transport/route-plans'];

/** Routes that read passenger personal data (the server asks the Super Admin for a reason there). */
export function accessReasonApplies(apiPath: string): boolean {
  if (PASSENGER_DATA_SECTIONS.some((s) => apiPath === s || apiPath.startsWith(`${s}/`) || apiPath.startsWith(`${s}?`))) return true;
  // Security review M1: an incident's detail (raiser, location); the lane itself is redacted for support, no reason.
  return apiPath.startsWith('/transport/incidents/');
}

/** Trimmed reason when it satisfies the server rule, else null. */
export function validAccessReason(raw: string): string | null {
  const r = raw.replace(/\s+/g, ' ').trim();
  return r.length >= ACCESS_REASON_MIN && r.length <= ACCESS_REASON_MAX ? r : null;
}

/** sessionStorage key of the remembered reason for one acting company. */
export function accessReasonKey(companyId: string | null): string {
  return `vt:access-reason:${companyId ?? 'own'}`;
}

/** Transport list / board pages whose header shows the customer picker (detail pages keep the selection in the URL). */
const PICKER_PATHS = ['/transport', '/transport/passengers', '/transport/schedules', '/transport/bookings', '/transport/dispatch', '/transport/planning'];

export function showsCustomerPicker(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PICKER_PATHS.includes(p);
}

/** Picker options: "all", then the own company, then customers in the server's order (value = company id). */
export const ALL_CUSTOMERS = 'all';
export function customerPickerOptions(
  customers: { customerCompanyId: string; name: string; mode: 'SELF' | 'AGREEMENT' }[],
  labels: { all: string; own: (name: string) => string },
): { value: string; label: string }[] {
  const self = customers.filter((c) => c.mode === 'SELF');
  const others = customers.filter((c) => c.mode !== 'SELF');
  return [{ value: ALL_CUSTOMERS, label: labels.all }, ...self.map((c) => ({ value: c.customerCompanyId, label: labels.own(c.name) })), ...others.map((c) => ({ value: c.customerCompanyId, label: c.name }))];
}
