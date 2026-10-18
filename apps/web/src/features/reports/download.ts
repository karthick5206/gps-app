import { ApiError, refreshAccessToken } from '@/lib/api';
import { session } from '@/lib/session';

function authHeaders(json: boolean): Headers {
  const h = new Headers({ Accept: '*/*' });
  if (json) h.set('Content-Type', 'application/json');
  const token = session.getAccessToken();
  if (token) h.set('Authorization', `Bearer ${token}`);
  const companyId = session.getCompanyId();
  if (companyId) h.set('X-Company-Id', companyId);
  return h;
}

async function errorOf(res: Response): Promise<ApiError> {
  let messages: string[] = [];
  try {
    const data = (await res.json()) as { message?: unknown };
    if (Array.isArray(data.message)) messages = data.message.map(String);
    else if (typeof data.message === 'string') messages = [data.message];
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, messages.length ? messages : [res.statusText || `Download failed (${res.status})`]);
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/**
 * Downloads a file through an authorised fetch (Bearer token + X-Company-Id, one refresh-and-retry on 401)
 * and saves it via a temporary object URL. Returns the saved file name.
 */
export async function downloadFile(path: string, { method = 'GET', body, fallbackName }: { method?: 'GET' | 'POST'; body?: unknown; fallbackName: string }): Promise<string> {
  const send = () =>
    fetch(`/api${path}`, { method, headers: authHeaders(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && (await refreshAccessToken())) res = await send();
  if (!res.ok) throw await errorOf(res);
  const blob = await res.blob();
  const name = filenameFrom(res, fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
