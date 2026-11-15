/**
 * Pricing API error codes (packages/shared/src/pricing/api.ts PricingErrorCode) → messages people can act on. Keys are
 * English source strings (translated with t()). Unknown codes fall back to the server's own message.
 */
import type { PricingErrorCode } from '@veetracer/shared';
import { ApiError, errorMessage } from '@/lib/api';

export const PRICING_ERROR_MESSAGES: Partial<Record<PricingErrorCode | 'REASON_REQUIRED', string>> = {
  VERSION_CONFLICT: 'Someone else changed this record meanwhile. Reload and try again.',
  CONTRACT_OVERLAP: 'Another active contract already covers this customer, branch and period. Change the validity or the branches.',
  CONTRACT_NOT_ACTIVE: 'The contract is not active.',
  CONTRACT_NOT_DRAFT: 'Only a draft can be changed. Create a new version to re-price.',
  CONTRACT_VERSION_IMMUTABLE: 'This version is no longer a draft and cannot be changed. Create a new version.',
  INVALID_COMPONENTS: 'Some pricing components are invalid. Check the highlighted cards.',
  NO_APPLICABLE_PRICING: 'No contract applies to this trip (customer, branch, vehicle or date).',
  VEHICLE_OVERRIDE_NOT_PERMITTED: 'This contract does not permit vehicle-level rates. Switch on “Vehicle rates permitted” in the contract header first (needs a draft contract).',
  TRIP_OVERRIDE_NOT_PERMITTED: 'This contract does not permit trip price overrides.',
  MAKER_CHECKER_SAME_USER: 'You can’t approve your own submission. Another user with approval rights must decide.',
  ALREADY_INVOICED: 'This trip is already on an invoice. Use an adjustment or a credit note instead.',
  INVOICE_ISSUED_IMMUTABLE: 'An issued invoice cannot be changed or deleted. Issue a credit note instead.',
  INVOICE_NOT_DRAFT: 'Only a draft invoice can do this.',
  NOTHING_TO_INVOICE: 'Nothing to invoice for this contract and period (no priced trips, closed periods or approved adjustments).',
  CREDIT_EXCEEDS_INVOICE: 'The credit is more than what is still creditable on this invoice.',
  BILLING_RUN_IN_PROGRESS: 'A billing run for this contract and period is already in progress. Try again in a few minutes.',
  BILLING_RUN_DONE: 'This period has already been processed.',
  CURRENCY_MISMATCH: 'The currency does not match the contract currency.',
  TAX_PROFILE_MISSING: 'The contract has no usable tax profile for this date. Set one in Pricing settings.',
  SUPPLIER_PROFILE_MISSING: 'Set up the supplier (your legal name, address and tax registration) in Pricing settings before issuing invoices.',
  GPS_DISTANCE_REVIEW: 'GPS distance is missing or unreliable. Enter the billable distance manually with a reason.',
  BRANCH_SCOPE: 'You can only use your own branches.',
  CONSOLIDATED_NEEDS_COMPANY_SCOPE: 'A consolidated invoice needs a company-wide user. Choose a branch.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request was not sent safely. Please try again.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already sent with different values. Reload and try again.',
  FORBIDDEN_GRANT: 'You do not have permission for this action.',
  COST_HIDDEN: 'Cost and margin need the “Operating costs & margin” permission.',
  NOT_FOUND: 'Not found. It may have been deleted, or it is outside your branches.',
  REASON_REQUIRED: 'A reason is required.',
};

/** Message for a failed pricing request; `t` translates the mapped English text. */
export function pricingErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError && err.code) {
    const mapped = PRICING_ERROR_MESSAGES[err.code as PricingErrorCode];
    if (mapped) return t(mapped);
  }
  if (err instanceof ApiError && err.status === 403) return t('You do not have permission for this action.');
  return errorMessage(err);
}
