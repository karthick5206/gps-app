/**
 * ETMS driver-to-passenger scenarios for `sim:route` (doc 12 WP 5.5; doc 11 §6 "Extending sim:route", §4 R6). Pure:
 * the scenario format, the driver events a scenario asks for at each stop, and the R6 replay plan (an offline queue sent
 * shuffled and duplicated). The runner (`scripts/etms-e2e/e5-scenarios.ts`) drives the vehicle with sim-trip and sends
 * these events through the real driver API.
 *
 * Format (`src/simulator/scenarios/etms-*.json`, alongside the v1.8 route scenarios):
 *   pickupsM        metres north of the office of each pickup stop (one passenger per pickup, in stop order); the
 *                   office is the last stop
 *   board           [{ stop, passengers }]: BOARDED at that pickup (passenger = index into pickupsM)
 *   noShow          [{ stop, passenger, reasonCode }]: NO_SHOW once the no-show wait has elapsed (P5: 5 min)
 *   reportDelay     { stop, reasonCode, etaMin } | null: REPORT_DELAY sent at that stop
 *   driverOffline   { fromStop, toStop } | null: the app is offline from arriving at `fromStop` until arriving at
 *                   `toStop`; the events of the stops in between are queued and replayed (R6) when it reconnects
 *                   (doc 11 §6 writes fromFrac / toFrac; driver events only happen at stops, so stops are used)
 *   replay          { seed, duplicateEvery, batchSize }: how the queue is replayed (shuffled with `seed`, every n-th
 *                   event sent twice, never twice in one batch since the API refuses that with 400)
 *   compareWith     another scenario whose final state this one must converge to (R6), or null
 *   expect          { passengers: final seat status per passenger, trip: final PlannedTrip status }
 * Every boarded passenger is DROPPED at the office (the last stop), then COMPLETE_TRIP.
 */

export type ScenarioSeatStatus = 'PENDING' | 'BOARDED' | 'NO_SHOW' | 'DROPPED';

export interface EtmsScenario {
  name: string;
  description: string;
  pickupsM: number[];
  board: { stop: number; passengers: number[] }[];
  noShow: { stop: number; passenger: number; reasonCode: string }[];
  reportDelay: { stop: number; reasonCode: string; etaMin: number } | null;
  driverOffline: { fromStop: number; toStop: number } | null;
  replay: { seed: number; duplicateEvery: number; batchSize: number };
  compareWith: string | null;
  expect: { passengers: ScenarioSeatStatus[]; trip: 'COMPLETED' };
}

/** One driver event the scenario asks for, before ids / seq / times are given to it. */
export interface PlannedEvent {
  type: 'ACKNOWLEDGE' | 'ARRIVED' | 'BOARDED' | 'NO_SHOW' | 'DEPARTED' | 'DROPPED' | 'REPORT_DELAY' | 'COMPLETE_TRIP';
  stopSeq?: number;
  passenger?: number;
  reasonCode?: string;
  etaMin?: number;
  /** NO_SHOW: send it only once the no-show wait after the stop's arrival has elapsed. */
  afterNoShowWait?: boolean;
}

const fail = (name: string, msg: string): never => {
  throw new Error(`scenario ${name}: ${msg}`);
};

/** Validates a scenario file (throws with the reason). */
export function parseScenario(raw: unknown): EtmsScenario {
  const s = raw as Partial<EtmsScenario>;
  const name = typeof s?.name === 'string' && /^etms-[a-z0-9-]+$/.test(s.name) ? s.name : fail(String(s?.name), 'name must be etms-<kebab>');
  const n = Array.isArray(s.pickupsM) && s.pickupsM.length >= 1 && s.pickupsM.every((m) => Number.isFinite(m) && m > 0) ? s.pickupsM.length : fail(name, 'pickupsM: at least one positive distance');
  const office = n;
  const stopOk = (q: unknown) => Number.isInteger(q) && (q as number) >= 0 && (q as number) <= office;
  const paxOk = (p: unknown) => Number.isInteger(p) && (p as number) >= 0 && (p as number) < n;
  const board = Array.isArray(s.board) ? s.board : fail(name, 'board must be an array');
  const noShow = Array.isArray(s.noShow) ? s.noShow : fail(name, 'noShow must be an array');
  for (const b of board) if (!stopOk(b.stop) || b.stop === office || !Array.isArray(b.passengers) || !b.passengers.every((p) => paxOk(p) && p === b.stop)) fail(name, `board ${JSON.stringify(b)}: a passenger boards at their own pickup stop`);
  for (const x of noShow) if (!paxOk(x.passenger) || x.stop !== x.passenger || typeof x.reasonCode !== 'string') fail(name, `noShow ${JSON.stringify(x)}: at the passenger's own pickup, with a reasonCode`);
  const seen = [...board.flatMap((b) => b.passengers), ...noShow.map((x) => x.passenger)];
  if (new Set(seen).size !== seen.length) fail(name, 'a passenger is both boarded and a no-show (or listed twice)');
  if (seen.length !== n) fail(name, 'every passenger needs an outcome (board or noShow)');
  const off = s.driverOffline ?? null;
  if (off && (!stopOk(off.fromStop) || !stopOk(off.toStop) || off.toStop <= off.fromStop)) fail(name, 'driverOffline: fromStop < toStop, both stops of the trip');
  if (off && off.toStop === office) fail(name, 'driverOffline: reconnect before the office (a trip auto-completed by GPS makes queued events LATE, defect D1)');
  const r = s.replay;
  if (!r || !Number.isInteger(r.seed) || !Number.isInteger(r.duplicateEvery) || r.duplicateEvery < 1 || !Number.isInteger(r.batchSize) || r.batchSize < 1 || r.batchSize > 50) fail(name, 'replay: { seed, duplicateEvery ≥ 1, batchSize 1-50 }');
  const d = s.reportDelay ?? null;
  if (d && (!stopOk(d.stop) || typeof d.reasonCode !== 'string' || !Number.isInteger(d.etaMin))) fail(name, 'reportDelay: { stop, reasonCode, etaMin }');
  const e = s.expect;
  if (!e || !Array.isArray(e.passengers) || e.passengers.length !== n || e.trip !== 'COMPLETED') fail(name, 'expect: { passengers: one status per passenger, trip: COMPLETED }');
  return { name, description: String(s.description ?? ''), pickupsM: s.pickupsM!, board, noShow, reportDelay: d, driverOffline: off, replay: r!, compareWith: s.compareWith ?? null, expect: e! };
}

/** The driver's taps at stop `seq`, in the order the driver makes them. */
export function plannedEventsAt(s: EtmsScenario, seq: number): PlannedEvent[] {
  const office = s.pickupsM.length;
  const out: PlannedEvent[] = [{ type: 'ARRIVED', stopSeq: seq }];
  if (s.reportDelay?.stop === seq) out.push({ type: 'REPORT_DELAY', reasonCode: s.reportDelay.reasonCode, etaMin: s.reportDelay.etaMin });
  if (seq === office) {
    const boarded = s.board.flatMap((b) => b.passengers).sort((a, b) => a - b);
    for (const p of boarded) out.push({ type: 'DROPPED', stopSeq: seq, passenger: p });
    out.push({ type: 'COMPLETE_TRIP' });
    return out;
  }
  for (const b of s.board.filter((x) => x.stop === seq)) for (const p of b.passengers) out.push({ type: 'BOARDED', passenger: p });
  for (const x of s.noShow.filter((y) => y.stop === seq)) out.push({ type: 'NO_SHOW', passenger: x.passenger, reasonCode: x.reasonCode, afterNoShowWait: true });
  out.push({ type: 'DEPARTED', stopSeq: seq });
  return out;
}

/** The app is offline while at stop `seq` (its events are queued, not sent). */
export const offlineAt = (s: EtmsScenario, seq: number): boolean => !!s.driverOffline && seq >= s.driverOffline.fromStop && seq < s.driverOffline.toStop;

/** Deterministic PRNG (mulberry32), so a replay is reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * R6 replay plan of an offline queue: the events shuffled, every `duplicateEvery`-th one (in queue order) sent a second
 * time, cut into batches of at most `batchSize` in which no clientEventId appears twice (the API answers 400 to that).
 * Every event of the queue is in the plan at least once.
 */
export function replayBatches<T extends { clientEventId: string }>(queue: readonly T[], o: { seed: number; duplicateEvery: number; batchSize: number }): T[][] {
  const rnd = prng(o.seed);
  const sends = shuffle([...queue, ...queue.filter((_, i) => (i + 1) % o.duplicateEvery === 0)], rnd);
  const batches: T[][] = [];
  for (const e of sends) {
    let b = batches.find((x) => x.length < o.batchSize && !x.some((y) => y.clientEventId === e.clientEventId));
    if (!b) batches.push((b = []));
    b.push(e);
  }
  return batches;
}

/** The parts of a trip's final state that must converge (R6), as a comparable string. */
export function convergenceKey(state: { status: string; stops: { seq: number; status: string }[]; passengers: { index: number; status: string }[] }): string {
  const stops = [...state.stops].sort((a, b) => a.seq - b.seq).map((x) => `${x.seq}:${x.status}`);
  const pax = [...state.passengers].sort((a, b) => a.index - b.index).map((x) => `${x.index}:${x.status}`);
  return `trip=${state.status} stops=${stops.join(',')} pax=${pax.join(',')}`;
}
