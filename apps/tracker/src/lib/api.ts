/**
 * Typed client for the tracker API (docs/mobile-tracker/API.md): activation and /me. Plain fetch.
 * Position uploads are done by the native engine (modules/veetrax-tracker), not from JS.
 */

export const SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://gps.mintplus.co.in').replace(/\/+$/, '');
export const API_BASE = `${SERVER_URL}/api/tracker/v1`;

export interface TrackerConfig {
  intervalSec: number;
  stoppedIntervalSec: number;
  distanceM: number;
  maxAccuracyM: number;
  batchMax: number;
}

export const DEFAULT_CONFIG: TrackerConfig = { intervalSec: 10, stoppedIntervalSec: 60, distanceM: 10, maxAccuracyM: 100, batchMax: 100 };

/** sentTo: masked e-mail addresses the code went to (device admins + the device's activation e-mail). */
export interface ActivateRequestResponse { ok: true; mobile: string; smsSent: boolean; emailSent?: boolean; sentTo?: string[]; expiresInSec: number }
export interface MeResponse { uniqueId: string; objectName: string; companyName: string; config: TrackerConfig }
export interface VerifyResponse extends MeResponse { token: string }
/** HTTP error from the server: status + message (+ code such as REVOKED / INVALID / INACTIVE). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got an HTTP response (offline, DNS, timeout). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

const TIMEOUT_MS = 30_000;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  if (!res.ok) {
    const obj = (json ?? {}) as { message?: unknown; code?: unknown };
    const msg = typeof obj.message === 'string' ? obj.message : Array.isArray(obj.message) ? obj.message.join(', ') : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, typeof obj.code === 'string' ? obj.code : undefined);
  }
  return json as T;
}

export const api = {
  requestCode: (mobile: string) => request<ActivateRequestResponse>('POST', '/activate/request', { mobile }),
  verify: (body: { mobile: string; code: string; deviceName: string; appVersion: string; platform: string }) =>
    request<VerifyResponse>('POST', '/activate/verify', body),
  me: (token: string) => request<MeResponse>('GET', '/me', undefined, token),
  diagnostics: (body: { appVersion: string; platform: string; device: string; nativeCrash: string | null; jsCrash: string | null }) =>
    request<{ ok: true }>('POST', '/diagnostics', body),
};
