/**
 * Covers a set of directed point pairs with as few multi-point engine requests as possible.
 *
 * A route request through points p0 → p1 → … → pk answers k legs (p0,p1), (p1,p2), … in one call. The cheapest cover
 * of a set of directed arcs by such walks is an Euler cover: the complete digraph (every off-diagonal cell of an n × n
 * matrix) has in-degree = out-degree everywhere, so ONE closed walk visits each of its n(n − 1) arcs exactly once.
 * A sparse set is balanced first through a virtual node (Hierholzer's algorithm); the circuit is then cut at the
 * virtual arcs into open trails, and each trail into requests of at most `maxLegs` legs. No arc is computed twice and
 * no arc that was not asked for is computed.
 */

export type Arc = [number, number];

/** Trails (point index sequences) that together traverse every arc exactly once. Self-loops are ignored. */
export function eulerTrails(arcs: Arc[]): number[][] {
  const real = arcs.filter(([a, b]) => a !== b);
  if (!real.length) return [];
  let maxNode = 0;
  for (const [a, b] of real) maxNode = Math.max(maxNode, a, b);
  const V = maxNode + 1; // virtual node
  const out: number[][] = Array.from({ length: V + 1 }, () => []);
  const bal = new Array<number>(V + 1).fill(0);
  for (const [a, b] of real) {
    out[a].push(b);
    bal[a]++;
    bal[b]--;
  }
  for (let u = 0; u < V; u++) {
    for (let k = 0; k < bal[u]; k++) out[V].push(u); // more out than in: enter u from the virtual node
    for (let k = 0; k < -bal[u]; k++) out[u].push(V); // more in than out: leave u to the virtual node
  }
  // Pop from the end (cheap); reverse so trails follow the input order where possible (stable, readable tests).
  for (const list of out) list.reverse();

  const trails: number[][] = [];
  const pushCircuit = (circuit: number[]) => {
    let cur: number[] = [];
    for (const node of circuit) {
      if (node === V) {
        if (cur.length > 1) trails.push(cur);
        cur = [];
      } else cur.push(node);
    }
    if (cur.length > 1) trails.push(cur);
  };
  const hierholzer = (start: number): number[] => {
    const stack = [start];
    const circuit: number[] = [];
    while (stack.length) {
      const u = stack[stack.length - 1];
      const next = out[u].pop();
      if (next === undefined) circuit.push(stack.pop()!);
      else stack.push(next);
    }
    return circuit.reverse();
  };
  // Start at the virtual node when it has arcs (so circuits are cut cleanly), then mop up the balanced components.
  if (out[V].length) pushCircuit(hierholzer(V));
  for (let u = 0; u < V; u++) if (out[u].length) pushCircuit(hierholzer(u));
  return trails;
}

/** Splits trails into request point lists of at most `maxLegs` legs (consecutive chunks share their end point). */
export function chunkTrails(trails: number[][], maxLegs: number): number[][] {
  const k = Math.max(1, Math.floor(maxLegs));
  const chunks: number[][] = [];
  for (const t of trails) for (let i = 0; i < t.length - 1; i += k) chunks.push(t.slice(i, Math.min(t.length, i + k + 1)));
  return chunks;
}

/** The arcs (legs) of a walk. */
export function legsOf(walk: number[]): Arc[] {
  const legs: Arc[] = [];
  for (let i = 1; i < walk.length; i++) legs.push([walk[i - 1], walk[i]]);
  return legs;
}
