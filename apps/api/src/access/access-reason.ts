import { BadRequestException } from '@nestjs/common';
import { ACCESS_REASON_MAX, ACCESS_REASON_MIN } from '@veetracer/shared';
import type { AuthContext } from './auth-context';

/** The X-Access-Reason header value: URI-decoded (the web encodes it so any language fits a header), trimmed, capped. */
export function accessReasonOf(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  let decoded = v;
  try {
    decoded = decodeURIComponent(v);
  } catch {
    /* not encoded: use as is */
  }
  const r = decoded.replace(/\s+/g, ' ').trim();
  return r ? r.slice(0, ACCESS_REASON_MAX) : null;
}

/**
 * Super Admin reason (doc 10 §2.2 item 8, E1b): VeeTrax support reads a customer's passenger personal data only with a
 * reason (header X-Access-Reason), which the read's ACCESS audit entry carries into the customer's sensitive-access log.
 * Missing or shorter than ACCESS_REASON_MIN → 400 REASON_REQUIRED (the web asks for it and retries). Everyone else may
 * send a reason (it is logged) but need not. Returns the reason to log, or null.
 */
export function requireSupportReason(ctx: Pick<AuthContext, 'isSuperAdmin'>, raw: string | string[] | undefined): string | null {
  const reason = accessReasonOf(raw);
  if (ctx.isSuperAdmin && (!reason || reason.length < ACCESS_REASON_MIN)) {
    throw new BadRequestException({
      message: `VeeTrax support must give a reason (at least ${ACCESS_REASON_MIN} characters) to see this company's passenger data; the customer's admin can see it`,
      code: 'REASON_REQUIRED',
    });
  }
  return reason;
}
