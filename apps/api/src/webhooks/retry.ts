import { WEBHOOK_DISABLE_AFTER_FAILURES, WEBHOOK_RETRY_DELAYS_SEC, WebhookDeliveryStatus } from '@veetracer/shared';

/** First attempt plus one per retry delay. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SEC.length + 1;

/** Delay before the next attempt after `attempt` (1-based) failed, or null when no attempts are left. */
export function retryDelaySec(attempt: number, delays: readonly number[] = WEBHOOK_RETRY_DELAYS_SEC): number | null {
  if (attempt < 1 || attempt > delays.length) return null;
  return delays[attempt - 1];
}

export const isSuccessStatus = (status: number | null | undefined): boolean => !!status && status >= 200 && status < 300;

export interface AttemptOutcome {
  status: WebhookDeliveryStatus;
  nextAttemptAt: Date | null;
  /** Endpoint failure streak after this attempt. */
  consecutiveFailures: number;
  /** True when this attempt pushes the endpoint over the limit and it must be switched off. */
  disableEndpoint: boolean;
}

/** What happens after attempt number `attempt` of a delivery (success, retry later, or give up). */
export function afterAttempt(
  attempt: number,
  success: boolean,
  failuresBefore: number,
  now: Date,
  opts: { delays?: readonly number[]; disableAfter?: number } = {},
): AttemptOutcome {
  if (success) return { status: 'SUCCEEDED', nextAttemptAt: null, consecutiveFailures: 0, disableEndpoint: false };
  const disableAfter = opts.disableAfter ?? WEBHOOK_DISABLE_AFTER_FAILURES;
  const consecutiveFailures = failuresBefore + 1;
  const disableEndpoint = failuresBefore < disableAfter && consecutiveFailures >= disableAfter;
  const delay = retryDelaySec(attempt, opts.delays);
  if (delay === null || disableEndpoint) return { status: 'FAILED', nextAttemptAt: null, consecutiveFailures, disableEndpoint };
  return { status: 'RETRYING', nextAttemptAt: new Date(now.getTime() + delay * 1000), consecutiveFailures, disableEndpoint };
}
