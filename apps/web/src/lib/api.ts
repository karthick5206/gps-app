import { ACCESS_REASON_HEADER, LICENCE_OVERRIDE_HEADER, type AuthTokens, type LicenceType } from '@veetracer/shared';
import { forgetAccessReason, rememberAccessReason, rememberedAccessReason } from './access-reason';
import { session } from './session';
import { reasonScopeFromError, reasonScopeOf, transportRequestHeaders } from './transport-context';

const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly messages: string[];
  /** Machine-readable app error code (e.g. LICENCE_REQUIRED, LICENCE_EXPIRED, USER_LICENCE_EXPIRED). */
  readonly code: string | null;
  readonly licenceType: LicenceType | null;
  /** The parsed JSON error body (extra fields such as routes[] of a refused route-plan publish). */
  readonly body: unknown;

  constructor(status: number, messages: string[], code: string | null = null, licenceType: LicenceType | null = null, body: unknown = null) {
    super(messages.join('\n') || `Request failed (${status})`);
    this.status = status;
    this.messages = messages;
    this.code = code;
    this.licenceType = licenceType;
    this.body = body;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Multipart body (file uploads); the browser sets the Content-Type boundary. */
  form?: FormData;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Skip the Authorization header and 401 refresh handling (auth endpoints). */
  anonymous?: boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

let onSessionExpired: (message?: string) => void = () => {};

/** Registers the handler invoked when the refresh token is rejected or the user's licence expired (logs the user out). */
export function setSessionExpiredHandler(handler: (message?: string) => void) {
  onSessionExpired = handler;
}

/**
 * A create refused for want of a free licence seat (402 LICENCE_REQUIRED). The handler (a dialog) resolves with an
 * override reason (Super Admin) to retry the request with it, or null to give up (the error is then thrown).
 */
let onLicenceRequired: ((err: ApiError) => Promise<string | null>) | null = null;

export function setLicenceRequiredHandler(handler: ((err: ApiError) => Promise<string | null>) | null) {
  onLicenceRequired = handler;
}

/**
 * ETMS (10 §2.2 item 8): the Super Admin reads a customer's passenger data only with a reason (400 REASON_REQUIRED
 * without one). The handler (a dialog) resolves with the reason to retry with (remembered for that customer company
 * for 30 minutes, security review L8), or null to give up (the error is then thrown).
 */
let onAccessReasonRequired: ((err: ApiError) => Promise<string | null>) | null = null;

export function setAccessReasonRequiredHandler(handler: ((err: ApiError) => Promise<string | null>) | null) {
  onAccessReasonRequired = handler;
}

export function buildQuery(query?: QueryParams): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Normalises Nest-style errors: `message` may be a string or a string[]. */
async function toApiError(res: Response): Promise<ApiError> {
  let messages: string[] = [];
  let code: string | null = null;
  let licenceType: LicenceType | null = null;
  let body: unknown = null;
  try {
    const data: unknown = await res.json();
    body = data;
    if (data && typeof data === 'object') {
      const d = data as { code?: unknown; licenceType?: unknown };
      if (typeof d.code === 'string') code = d.code;
      if (typeof d.licenceType === 'string') licenceType = d.licenceType as LicenceType;
    }
    if (data && typeof data === 'object' && 'message' in data) {
      const m = (data as { message: unknown }).message;
      if (Array.isArray(m)) messages = m.map(String);
      else if (typeof m === 'string') messages = [m];
    }
  } catch {
    /* non-JSON body */
  }
  if (!messages.length) messages = [res.status === 429 ? 'Too many attempts. Please wait and try again.' : res.statusText || `Request failed (${res.status})`];
  return new ApiError(res.status, messages, code, licenceType, body);
}

function headers(opts: RequestOptions): Headers {
  const h = new Headers({ Accept: 'application/json' });
  if (opts.body !== undefined) h.set('Content-Type', 'application/json');
  if (!opts.anonymous) {
    const token = session.getAccessToken();
    if (token) h.set('Authorization', `Bearer ${token}`);
    const companyId = session.getCompanyId();
    if (companyId) h.set('X-Company-Id', companyId);
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  return h;
}

function send(path: string, opts: RequestOptions): Promise<Response> {
  return fetch(`${BASE}${path}${buildQuery(opts.query)}`, {
    method: opts.method ?? 'GET',
    headers: headers(opts),
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    signal: opts.signal,
  });
}

let refreshing: Promise<boolean> | null = null;

/** Single-flight access-token refresh. Resolves false when the refresh token is missing or rejected. */
export function refreshAccessToken(): Promise<boolean> {
  if (refreshing) return refreshing;
  const refreshToken = session.getRefreshToken();
  if (!refreshToken) return Promise.resolve(false);
  refreshing = (async () => {
    try {
      const res = await send('/auth/refresh', { method: 'POST', body: { refreshToken }, anonymous: true });
      if (!res.ok) return false;
      session.setTokens((await res.json()) as AuthTokens);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** The browser location, for the transport customer header (null outside a browser, e.g. in unit tests). */
function currentLocation(): { pathname: string; search: string } | null {
  return typeof window === 'undefined' ? null : window.location;
}

/** Fetch with auth headers, one refresh-and-retry on 401, and logout when the refresh fails. */
async function authorizedFetch(path: string, optsIn: RequestOptions, reasonAsked = false): Promise<Response> {
  // ETMS E1b: customer picker (X-Transport-Customer) and the remembered Super Admin reason; explicit headers win.
  const acting = session.getCompanyId();
  const scope = reasonScopeOf(path, currentLocation(), acting);
  const extra = optsIn.anonymous ? {} : transportRequestHeaders(path, currentLocation(), scope ? rememberedAccessReason(acting, scope) : null);
  const opts: RequestOptions = Object.keys(extra).length ? { ...optsIn, headers: { ...extra, ...optsIn.headers } } : optsIn;
  let res = await send(path, opts);
  if (res.status === 401 && !opts.anonymous) {
    if (await refreshAccessToken()) {
      res = await send(path, opts);
    } else {
      onSessionExpired();
    }
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (err.code === 'USER_LICENCE_EXPIRED' && !opts.anonymous) onSessionExpired(err.message);
    // Seat licences only: the Developer API licence (API_ACCESS) has no per-create override; its message is shown as is.
    if (err.status === 402 && err.code === 'LICENCE_REQUIRED' && err.licenceType !== 'API_ACCESS' && onLicenceRequired && !opts.headers?.[LICENCE_OVERRIDE_HEADER]) {
      const reason = await onLicenceRequired(err);
      if (reason) return authorizedFetch(path, { ...opts, headers: { ...opts.headers, [LICENCE_OVERRIDE_HEADER]: encodeURIComponent(reason) } });
    }
    if (err.status === 400 && err.code === 'REASON_REQUIRED' && onAccessReasonRequired && !reasonAsked && !opts.anonymous) {
      // L8: the reason belongs to the data owner the server names (else the scope worked out before sending).
      const owner = reasonScopeFromError(err.body) ?? scope ?? acting;
      const known = rememberedAccessReason(acting, owner);
      if (known && !opts.headers?.[ACCESS_REASON_HEADER]) {
        // Still valid for that company (e.g. an incident detail, whose owner was unknown before): no need to ask again.
        return authorizedFetch(path, { ...optsIn, headers: { ...optsIn.headers, [ACCESS_REASON_HEADER]: encodeURIComponent(known) } }, true);
      }
      // A remembered reason the server refused is dropped; ask once per request.
      forgetAccessReason(acting, owner);
      const reason = await onAccessReasonRequired(err);
      if (reason) {
        rememberAccessReason(acting, owner, reason);
        const headers = { ...optsIn.headers, [ACCESS_REASON_HEADER]: encodeURIComponent(reason) };
        return authorizedFetch(path, { ...optsIn, headers }, true);
      }
    }
    throw err;
  }
  return res;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await authorizedFetch(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: QueryParams, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts?: Pick<RequestOptions, 'anonymous'>) =>
    request<T>(path, { method: 'POST', body: body ?? {}, ...opts }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** POST multipart/form-data (e.g. a document scan). */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', form }),
};

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/** Downloads a CSV export (`format=csv`) through the authorised fetch and saves it via a temporary link. */
export async function downloadCsv(path: string, query: QueryParams, fallbackName: string): Promise<void> {
  const res = await authorizedFetch(path, { query: { ...query, format: 'csv', page: undefined, pageSize: undefined } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res, fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** GET a binary resource (e.g. an image) through the authorised fetch. */
export async function fetchBlob(path: string): Promise<Blob> {
  return (await authorizedFetch(path, {})).blob();
}

/** Downloads a file (GET) through the authorised fetch and saves it via a temporary link. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await authorizedFetch(path, {});
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res, fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
