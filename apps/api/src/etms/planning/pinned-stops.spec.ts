import { pinnedStopsMoved, type StopPlacement } from './plan-rules';

/**
 * The pin decision of the manual plan edits (resequence, move-passenger), pure (E4 review M2: the DB test
 * e4-e2e-fixes.db-test.ts runs only with ETMS_DB_TEST_URL; this one runs in every `npx jest`).
 */
type S = { id: string; ref: string; assignmentId: string | null; sequence: number | null };
const s = (id: string, assignmentId: string | null, sequence: number | null): S => ({ id, ref: id, assignmentId, sequence });
const place = (entries: [string, string | null, number | null][]) => new Map<string, StopPlacement>(entries.map(([id, a, q]) => [id, { assignmentId: a, sequence: q }]));
/** The placements a resequence of `order` on route `a` writes (sequence from 0). */
const reorder = (a: string, order: string[]) => place(order.map((id, i) => [id, a, i]));

describe('pinned stops in manual edits', () => {
  // As the optimiser writes them: sequence 1..n (the T2-L3 root cause).
  const optimised = [s('p0', 'A', 1), s('p1', 'A', 2), s('d0', 'A', 3), s('d1', 'A', 4)];

  it('T2-L3: after an optimisation (sequences from 1) a reorder that leaves the pinned stop in its place is accepted', () => {
    // Swap the two pickups; the pinned drop d1 stays last (stored 4, written 3).
    expect([...pinnedStopsMoved(new Set(['d1']), optimised, reorder('A', ['p1', 'p0', 'd0', 'd1']))]).toEqual([]);
  });

  it('a pinned stop moved to another route or out of every route is refused', () => {
    const two = [...optimised, s('x', 'B', 0)];
    expect([...pinnedStopsMoved(new Set(['p0']), two, place([['p0', 'B', 1], ['x', 'B', 0]]))]).toEqual(['p0']);
    expect([...pinnedStopsMoved(new Set(['p0']), two, place([['p0', null, null]]))]).toEqual(['p0']);
  });

  it('unpinned stops never count', () => {
    expect([...pinnedStopsMoved(new Set(), optimised, place([['p0', null, null]]))]).toEqual([]);
  });
});
