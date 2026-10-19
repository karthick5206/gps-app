import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay (Orders API + Checkout + webhooks) over plain HTTPS. Disabled unless all three env vars are set. */
export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export function razorpayConfig(env: NodeJS.ProcessEnv = process.env): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return keyId && keySecret && webhookSecret ? { keyId, keySecret, webhookSecret } : null;
}

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(expected: string, given: string | undefined | null): boolean {
  if (!given || typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout handler response: signature = HMAC-SHA256(key secret, "<order_id>|<payment_id>"). */
export function verifyCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): boolean {
  return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

/** Webhook: X-Razorpay-Signature = HMAC-SHA256(webhook secret, raw request body). */
export function verifyWebhookSignature(webhookSecret: string, rawBody: Buffer | string, signature: string | undefined): boolean {
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  email?: string;
  contact?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const BASE = 'https://api.razorpay.com/v1';

export class RazorpayClient {
  constructor(
    private readonly config: RazorpayConfig,
    private readonly http: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get keyId(): string {
    return this.config.keyId;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    const res = await this.http(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Razorpay ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  createOrder(amountPaise: number, receipt: string, notes: Record<string, string>): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt: receipt.slice(0, 40), notes });
  }

  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean {
    return verifyCheckoutSignature(this.config.keySecret, orderId, paymentId, signature);
  }

  verifyWebhook(rawBody: Buffer | string, signature: string | undefined): boolean {
    return verifyWebhookSignature(this.config.webhookSecret, rawBody, signature);
  }
}

/** Payment id / order id / amount from a payment.captured or order.paid webhook payload. */
export function webhookPayment(body: unknown): { event: string; paymentId: string | null; orderId: string | null; amount: number | null; status: string | null } {
  const b = (body ?? {}) as { event?: string; payload?: { payment?: { entity?: RazorpayPayment }; order?: { entity?: RazorpayOrder } } };
  const payment = b.payload?.payment?.entity;
  const order = b.payload?.order?.entity;
  return {
    event: String(b.event ?? ''),
    paymentId: payment?.id ?? null,
    orderId: payment?.order_id ?? order?.id ?? null,
    amount: typeof payment?.amount === 'number' ? payment.amount : null,
    status: payment?.status ?? null,
  };
}
