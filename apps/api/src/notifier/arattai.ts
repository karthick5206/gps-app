import { Logger } from '@nestjs/common';
import type { MessagingSettings, PrismaClient } from '@prisma/client';

/*
 * Arattai Business (Zoho) messages, switched on / off by the Super Admin (Platform Settings → Messaging):
 * - verification codes: authentication template with {{otp}} and {{validity_minutes}} (POST /api/v1/authentications);
 * - alerts: transactional template with {{alert}}, {{vehicle}}, {{time}} and {{details}} (POST /api/v1/transactions).
 * Codes also go by SMS / e-mail, so Arattai being off or failing never stops a code.
 * OAuth: access token (1 hour) renewed from the stored refresh token. Docs: arattaibusiness.in/business-platform/developers.
 */
export const ARATTAI_ACCOUNTS = process.env.ARATTAI_ACCOUNTS_URL ?? 'https://accounts.arattai.in';
export const ARATTAI_API = process.env.ARATTAI_API_URL ?? 'https://business.arattai.in';
/** Send messages; read the company and business numbers so Connect can fill in their ids. */
export const ARATTAI_SCOPE = 'ArattaiBusiness.messages.CREATE,ArattaiBusiness.companies.READ,ArattaiBusiness.businesses.READ';
const TIMEOUT_MS = 10_000;

/** The Arattai part of the messaging settings. */
export interface ArattaiConfig {
  enabled: boolean;
  companyId: string;
  businessNumberId: string;
  otpTemplateId: string;
  alertTemplateId: string;
  language: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const arattaiConfig = (s: MessagingSettings | null): ArattaiConfig | null =>
  s && {
    enabled: s.arattaiEnabled,
    companyId: s.arattaiCompanyId,
    businessNumberId: s.arattaiBusinessNumberId,
    otpTemplateId: s.arattaiOtpTemplateId,
    alertTemplateId: s.arattaiAlertTemplateId,
    language: s.arattaiLanguage,
    clientId: s.arattaiClientId,
    clientSecret: s.arattaiClientSecret,
    refreshToken: s.arattaiRefreshToken,
  };

/** "919876543210" / "+91 98765 43210" → "91-9876543210" (Arattai's format). Only Indian mobiles; else null. */
export function arattaiPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  const local = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 10 ? d : null;
  return local && /^[6-9]\d{9}$/.test(local) ? `91-${local}` : null;
}

/** Connected: switched on, both ids, the API client and the refresh token. Each send also needs its template. */
export function arattaiReady(c: Pick<ArattaiConfig, 'enabled' | 'companyId' | 'businessNumberId' | 'clientId' | 'clientSecret' | 'refreshToken'> | null): boolean {
  return !!c && c.enabled && !!c.companyId && !!c.businessNumberId && !!c.clientId && !!c.clientSecret && !!c.refreshToken;
}

type Fetch = typeof fetch;
export interface SendResult {
  sent: boolean;
  error: string | null;
}

export class ArattaiOtp {
  private readonly logger = new Logger('Arattai');
  private token: { value: string; until: number; key: string } | null = null;

  constructor(
    private readonly prisma: Pick<PrismaClient, 'messagingSettings'>,
    private readonly http: Fetch = fetch,
  ) {}

  async config(): Promise<ArattaiConfig | null> {
    return arattaiConfig(await this.prisma.messagingSettings.findUnique({ where: { id: 'default' } }));
  }

  /** Verification codes can go by Arattai (switched on, connected, OTP template set). */
  async ready(): Promise<boolean> {
    const c = await this.config();
    return arattaiReady(c) && !!c?.otpTemplateId;
  }

  /** Forget the cached access token (settings changed / reconnected). */
  reset(): void {
    this.token = null;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await this.http(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Access token from the refresh token, cached until a minute before it expires. */
  private async accessToken(c: ArattaiConfig): Promise<string> {
    const key = `${c.clientId}|${c.refreshToken.slice(-8)}`;
    if (this.token && this.token.key === key && Date.now() < this.token.until) return this.token.value;
    const q = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
    const res = await this.call(`${ARATTAI_ACCOUNTS}/oauth/v2/token?${q}`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Arattai token refresh failed: ${body.error ?? res.status}`);
    this.token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000, key };
    return body.access_token;
  }

  /** One template message; never throws: the reason is returned and kept for Platform Settings. */
  private async post(path: '/api/v1/authentications' | '/api/v1/transactions', c: ArattaiConfig, templateId: string, mobile: string, variables: Record<string, string>): Promise<SendResult> {
    const phone = arattaiPhone(mobile);
    if (!phone) return { sent: false, error: 'Not an Indian mobile number' };
    let error: string | null = null;
    try {
      const token = await this.accessToken(c);
      const res = await this.call(`${ARATTAI_API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Arattai-CompanyId': c.companyId, 'Arattai-BusinessNumberId': c.businessNumberId, 'content-type': 'application/json' },
        body: JSON.stringify({ id: templateId, phone_number: phone, language: c.language || 'en', variables }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; error?: string };
        if (res.status === 401) this.reset();
        error = `Arattai ${res.status}: ${body.code ?? body.error ?? ''} ${body.message ?? ''}`.trim();
      }
    } catch (e) {
      error = (e as Error).name === 'AbortError' ? 'Arattai did not answer in 10 seconds' : (e as Error).message;
    }
    if (error) this.logger.warn(`${path} to ${phone.slice(0, -4)}•••• not sent: ${error}`);
    await this.prisma.messagingSettings
      .update({ where: { id: 'default' }, data: error ? { arattaiLastError: `${new Date().toISOString()} ${error}` } : { arattaiLastSentAt: new Date(), arattaiLastError: null } })
      .catch(() => undefined);
    return { sent: !error, error };
  }

  /** Verification code (authentication template). Off / not set up = not sent, no error. */
  async sendOtp(mobile: string, code: string, validityMinutes: number, opts: { evenIfOff?: boolean } = {}): Promise<SendResult> {
    const c = await this.config();
    // "Send test" in Platform Settings checks the set-up while the switch is still off.
    const ok = arattaiReady(c && opts.evenIfOff ? { ...c, enabled: true } : c) && !!c?.otpTemplateId;
    if (!ok) return { sent: false, error: opts.evenIfOff ? 'Fill in the ids and the OTP template, then press Connect Arattai' : null };
    return this.post('/api/v1/authentications', c!, c!.otpTemplateId, mobile, { otp: code, validity_minutes: String(validityMinutes) });
  }

  /** Alert (transactional template). Throws when it can't be sent, so the notifier logs and retries it like SMS. */
  async sendAlert(mobile: string, v: { alert: string; vehicle: string; time: string; details: string }): Promise<void> {
    const c = await this.config();
    if (!arattaiReady(c)) throw new Error('Arattai is switched off or not connected');
    if (!c!.alertTemplateId) throw new Error('No Arattai alert template set (Platform Settings → Messaging)');
    // Template variables have limits: keep each short.
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const r = await this.post('/api/v1/transactions', c!, c!.alertTemplateId, mobile, { alert: cut(v.alert, 60), vehicle: cut(v.vehicle, 60), time: cut(v.time, 40), details: cut(v.details, 300) });
    if (!r.sent) throw new Error(r.error ?? 'Arattai send failed');
  }

  /** "Connect Arattai": the approval page the Super Admin opens once (offline access → refresh token). */
  connectUrl(c: Pick<ArattaiConfig, 'clientId'>, redirectUri: string, state: string): string {
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, scope: ARATTAI_SCOPE, redirect_uri: redirectUri, access_type: 'offline', prompt: 'consent', tenant: 'ArattaiBusiness', state });
    return `${ARATTAI_ACCOUNTS}/oauth/v2/auth?${q}`;
  }

  /** Exchanges the approval code for the refresh token (stored by the caller). */
  async exchange(c: Pick<ArattaiConfig, 'clientId' | 'clientSecret'>, code: string, redirectUri: string, accountsServer?: string): Promise<string> {
    const q = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri });
    // The code must be redeemed at the accounts server that issued it (sent back with the redirect); only Arattai's own.
    const server = accountsServer && /^https:\/\/accounts\.arattai\.[a-z.]+$/.test(accountsServer) ? accountsServer : ARATTAI_ACCOUNTS;
    const res = await this.call(`${server}/oauth/v2/token?${q}`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!res.ok || !body.refresh_token) throw new Error(body.error ? `Arattai said: ${body.error}` : `Arattai token request failed (${res.status})`);
    this.reset();
    return body.refresh_token;
  }

  /**
   * After Connect: the company id (GET /api/v1/companies) and the id of the business number matching `phone` (or the
   * only one) from GET /api/v1/businesses. Returns what it found; nothing is thrown (ids can still be typed in).
   */
  async discover(c: Pick<ArattaiConfig, 'clientId' | 'clientSecret' | 'refreshToken'>, phone: string | null): Promise<{ companyId: string | null; businessNumberId: string | null; numbers: string[] }> {
    const out = { companyId: null as string | null, businessNumberId: null as string | null, numbers: [] as string[] };
    try {
      const token = await this.accessToken({ ...c, enabled: true, companyId: '', businessNumberId: '', otpTemplateId: '', alertTemplateId: '', language: 'en' });
      const auth = { Authorization: `Bearer ${token}` };
      const companies = (await (await this.call(`${ARATTAI_API}/api/v1/companies`, { headers: auth })).json().catch(() => ({}))) as { data?: { id?: string | number }[] };
      const companyId = companies.data?.length === 1 && companies.data[0].id != null ? String(companies.data[0].id) : null;
      out.companyId = companyId;
      if (!companyId) return out;
      const biz = (await (await this.call(`${ARATTAI_API}/api/v1/businesses`, { headers: { ...auth, 'Arattai-CompanyId': companyId } })).json().catch(() => ({}))) as { data?: { businessnumbers?: { id?: string | number; phonenumber?: string; full_phonenumber?: string }[] }[] };
      const nums = (biz.data ?? []).flatMap((b) => b.businessnumbers ?? []).filter((n) => n.id != null);
      out.numbers = nums.map((n) => n.full_phonenumber ?? n.phonenumber ?? '');
      const want = phone?.replace(/\D/g, '').slice(-10);
      const match = (want && nums.find((n) => (n.full_phonenumber ?? n.phonenumber ?? '').replace(/\D/g, '').endsWith(want))) || (nums.length === 1 ? nums[0] : undefined);
      out.businessNumberId = match ? String(match.id) : null;
    } catch (e) {
      this.logger.warn(`Arattai id lookup failed: ${(e as Error).message}`);
    }
    return out;
  }
}
