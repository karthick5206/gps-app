import type { AuthTokens } from '@veetracer/shared';
import { API_URL } from './config';
import { i18n } from './i18n';
import { session } from './session';

/** REST client for the Veetrax API (same contract as the web app's lib/api.ts). */

export class ApiError extends Error {
  readonly status: number;
  readonly messages: string[];

  constructor(status: number, messages: string[]) {
    super(messages.join('\n') || i18n.t('Request failed ({{status}})', { status }));
    this.status = status;
    this.messages = messages;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Skip the Authorization header and 401 refresh handling (auth endpoints). */
  anonymous?: boolean;
}

let onSessionExpired: () => void = () => {};

/** Registers the handler invoked when the refresh token is rejected (signs the user out). */
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export function buildQuery(query?: QueryParams): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Normalises Nest-style errors: `message` may be a string or a string[]. */
async function toApiError(res: Response): Promise<ApiError> {
  let messages: string[] = [];
  try {
    const data: unknown = await res.json();
    if (data && typeof data === 'object' && 'message' in data) {
      const m = (data as { message: unknown }).message;
      if (Array.isArray(m)) messages = m.map(String);
      else if (typeof m === 'string') messages = [m];
    }
  } catch {
    /* non-JSON body */
  }
  if (!messages.length) messages = [res.status === 429 ? i18n.t('Too many attempts. Please wait and try again.') : i18n.t('Request failed ({{status}})', { status: res.status })];
  return new ApiError(res.status, messages);
}

function headers(opts: RequestOptions): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) h['Content-Type'] = 'application/json';
  if (!opts.anonymous) {
    const token = session.getAccessToken();
    if (token) h.Authorization = `Bearer ${token}`;
    const companyId = session.getCompanyId();
    if (companyId) h['X-Company-Id'] = companyId;
  }
  return h;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? 'GET',
      headers: headers(opts),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, [i18n.t('No connection to the server. Check your internet and try again.')]);
  }
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

/** Fetch with auth headers, one refresh-and-retry on 401, and sign-out when the refresh fails. */
async function authorizedFetch(path: string, opts: RequestOptions): Promise<Response> {
  let res = await send(path, opts);
  if (res.status === 401 && !opts.anonymous) {
    if (await refreshAccessToken()) res = await send(path, opts);
    else onSessionExpired();
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

/** Raw response (file downloads) with the same auth / refresh handling. */
export function requestRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
  return authorizedFetch(path, opts);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await authorizedFetch(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: QueryParams, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts?: Pick<RequestOptions, 'anonymous'>) => request<T>(path, { method: 'POST', body: body ?? {}, ...opts }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return i18n.t('Something went wrong');
}
