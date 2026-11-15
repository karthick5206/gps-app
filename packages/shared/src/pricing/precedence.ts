/** Contract precedence (doc 19 §5.7): explicit failure instead of a silent fallback; never another customer's rate. */
import type { ContractCandidate, ContractSelection, ContractSelectionQuery } from './types';

const covers = (c: ContractCandidate, date: string) => c.status === 'ACTIVE' && c.validFrom <= date && (c.validTo === null || date < c.validTo);

/** Specificity: branch + category = 3, branch = 2, category = 1, none = 0; -1 = does not apply. */
function specificity(c: ContractCandidate, q: ContractSelectionQuery): number {
  const branchSpecific = c.branchIds.length > 0;
  if (branchSpecific && !(q.branchId && c.branchIds.includes(q.branchId))) return -1;
  const catSpecific = !!c.vehicleCategory;
  if (catSpecific && c.vehicleCategory !== q.vehicleCategory) return -1;
  return (branchSpecific ? 2 : 0) + (catSpecific ? 1 : 0);
}

function pick(cands: ContractCandidate[], q: ContractSelectionQuery): { winner: ContractCandidate | null; ambiguous: boolean; level: number } {
  let best = -1;
  let winners: ContractCandidate[] = [];
  for (const c of cands) {
    const s = specificity(c, q);
    if (s < 0) continue;
    if (s > best) {
      best = s;
      winners = [c];
    } else if (s === best) winners.push(c);
  }
  return { winner: winners.length === 1 ? winners[0] : null, ambiguous: winners.length > 1, level: best };
}

const LEVEL = ['company-wide', 'vehicle category', 'branch', 'branch + vehicle category'];

export function selectContract(candidates: readonly ContractCandidate[], q: ContractSelectionQuery): ContractSelection {
  const live = candidates.filter((c) => covers(c, q.serviceDate));
  const own = live.filter((c) => !c.isDefault && c.customerCompanyId === q.customerCompanyId);
  if (own.length) {
    const r = pick(own, q);
    if (r.ambiguous) return { ok: false, code: 'NO_APPLICABLE_PRICING', reason: `ambiguous: several ${LEVEL[r.level]} contracts match on ${q.serviceDate}` };
    if (r.winner) return { ok: true, contractId: r.winner.id, viaDefault: false, basis: `customer contract (${LEVEL[r.level]})` };
  }
  // A customer contract exists for the date but none matches the branch / category: no fallback to the default.
  if (own.length) return { ok: false, code: 'NO_APPLICABLE_PRICING', reason: `the customer's contract does not cover this branch / vehicle category on ${q.serviceDate}` };
  const need = q.customerCompanyId === null ? 'INTERNAL' : 'EXTERNAL';
  const defaults = live.filter((c) => c.isDefault && c.customerCompanyId === null && (c.defaultCovers ?? []).includes(need));
  if (defaults.length) {
    const r = pick(defaults, q);
    if (r.ambiguous) return { ok: false, code: 'NO_APPLICABLE_PRICING', reason: 'ambiguous: several default contracts match' };
    if (r.winner) return { ok: true, contractId: r.winner.id, viaDefault: true, basis: `company default contract (${need.toLowerCase()} customers)` };
  }
  return { ok: false, code: 'NO_APPLICABLE_PRICING', reason: `no active contract for this customer on ${q.serviceDate}` };
}
