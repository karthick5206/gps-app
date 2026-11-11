/** Minimal HTTP client for the ETMS E3 gate's HTTP stage (Node fetch; no new dependency). */
export interface Res<T = any> {
  s: number;
  b: T;
  h: Headers;
}

export class Api {
  constructor(readonly base: string) {}

  async call<T = any>(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const r = await fetch(`${this.base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: unknown = text;
    try {
      b = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { s: r.status, b: b as T, h: r.headers };
  }

  async login(email: string, password: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const r = await this.call<{ accessToken: string }>(null, 'POST', '/auth/login', { email, password });
      if (r.s === 200 || r.s === 201) return r.b.accessToken;
      if (r.s === 429) {
        await new Promise((res) => setTimeout(res, 15_000));
        continue;
      }
      throw new Error(`login ${email}: ${r.s} ${JSON.stringify(r.b).slice(0, 200)}`);
    }
    throw new Error(`login ${email}: throttled`);
  }
}

/** `<status> <code>` of a response, e.g. `404 NOT_FOUND`. */
export const sc = (r: Res): string => `${r.s}${r.b && typeof r.b === 'object' && 'code' in r.b ? ` ${(r.b as { code: string }).code}` : ''}`;

export interface CheckResult {
  criterion: string;
  title: string;
  status: 'passed' | 'failed' | 'pending';
  detail?: unknown;
}

/** Collects the HTTP stage's checks in the gate's result shape. Tagged checks (regressions of merged fixes) always run. */
export class Recorder {
  readonly results: CheckResult[] = [];
  constructor(private readonly enabled: { secfix: boolean; known: boolean }) {}

  check(criterion: string, title: string, ok: boolean, detail?: unknown): boolean {
    this.results.push({ criterion, title: `[${criterion}] ${title}`, status: ok ? 'passed' : 'failed', detail });
    console.log(`    ${ok ? 'PASS' : 'FAIL'} [${criterion}] ${title}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
    return ok;
  }

  /**
   * A check tied to a fix, `tag` = e.g. 'secfix B5'. The fixes are merged, so it always runs; a tag starting with
   * 'pending' (a future fix not merged yet) is recorded as pending unless --secfix / --known-defects is given.
   */
  tagged(criterion: string, tag: string, title: string, ok: () => boolean, detail?: unknown): void {
    const on = !tag.startsWith('pending') || (tag.includes('secfix') ? this.enabled.secfix : this.enabled.known);
    if (!on) {
      this.results.push({ criterion, title: `[${criterion}][${tag}] ${title}`, status: 'pending', detail });
      return;
    }
    this.check(`${criterion}`, `[${tag}] ${title}`, ok(), detail);
  }

  /** Runs a block; an exception is recorded as a failed check instead of aborting the stage. */
  async step(criterion: string, title: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.check(criterion, `${title} (threw)`, false, (e as Error).message);
    }
  }
}
