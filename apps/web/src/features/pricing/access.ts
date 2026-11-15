/**
 * Who sees what in the Pricing area. Cost and margin are their own menu (pricing_costs) so ordinary pricing roles never
 * see them (doc 19 §5.10): the API already projects cost columns out; the UI hides them as well so a stale cache or an
 * unexpected column never shows cost to someone without the grant. Pure module: unit-tested with node --test.
 */
import { can, type PermissionMap, type PricingReportColumn } from '@veetracer/shared';

export const canSeeCosts = (permissions: PermissionMap | undefined): boolean => !!permissions && can(permissions, 'pricing_costs', 'view');

/** Report / dashboard keys that carry cost or margin. */
const COST_KEY = /^(cost|margin)/i;
export const isCostColumn = (key: string): boolean => COST_KEY.test(key);

/** Columns the viewer may see: cost / margin columns only with pricing_costs:view (and only when the server sent them). */
export function visibleColumns<C extends Pick<PricingReportColumn, 'key'>>(columns: readonly C[], costsAllowed: boolean): C[] {
  return costsAllowed ? [...columns] : columns.filter((c) => !isCostColumn(c.key));
}

/** Report types offered in the picker: margin needs pricing_costs:view (the API answers 403 COST_HIDDEN otherwise). */
export function reportTypesFor<T extends string>(types: readonly T[], costsAllowed: boolean): T[] {
  return costsAllowed ? [...types] : types.filter((t) => t !== 'margin');
}

/** Maker-checker (doc 19 §9.4 #5): the submitter / requester never approves their own request, even with the grant. */
export function canDecide(opts: { hasApprove: boolean; submittedById: string | null | undefined; meId: string | undefined }): { allowed: boolean; ownSubmission: boolean } {
  const ownSubmission = !!opts.meId && !!opts.submittedById && opts.meId === opts.submittedById;
  return { allowed: opts.hasApprove && !ownSubmission, ownSubmission };
}
