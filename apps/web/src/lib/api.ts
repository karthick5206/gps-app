import type { AuthTokens } from '@veetracer/shared';
import { session } from './session';

const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly messages: string[];

  constructor(status: number, messages: string[]) {
    super(messages.join('\n') || `Request failed (${status})`);
    this.status = status;
    this.messages = messages;
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
}

let onSessionExpired: () => void = () => {};

/** Registers the handler invoked when the refresh token is rejected (logs the user out). */
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
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
  if (!messages.length) messages = [res.status === 429 ? 'Too many attempts. Please wait and try again.' : res.statusText || `Request failed (${res.status})`];
  return new ApiError(res.status, messages);
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

/** Fetch with auth headers, one refresh-and-retry on 401, and logout when the refresh fails. */
async function authorizedFetch(path: string, opts: RequestOptions): Promise<Response> {
  let res = await send(path, opts);
  if (res.status === 401 && !opts.anonymous) {
    if (await refreshAccessToken()) {
      res = await send(path, opts);
    } else {
      onSessionExpired();
    }
  }
  if (!res.ok) throw await toApiError(res);
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
