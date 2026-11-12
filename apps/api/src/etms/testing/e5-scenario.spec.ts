import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convergenceKey, offlineAt, parseScenario, plannedEventsAt, prng, replayBatches, shuffle } from './e5-scenario';

const DIR = join(__dirname, '..', '..', 'simulator', 'scenarios');
const load = (name: string) => parseScenario(JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')));

describe('ETMS sim scenarios (E5 WP 5.5)', () => {
  it('the three bundled scenarios parse', () => {
    expect(['etms-on-time', 'etms-no-show', 'etms-offline-driver'].map((n) => load(n).name)).toEqual(['etms-on-time', 'etms-no-show', 'etms-offline-driver']);
    expect(load('etms-offline-driver').compareWith).toBe('etms-on-time');
  });

  it('plans the driver taps per stop: pickups ARRIVED / outcome / DEPARTED, office DROPPED × boarded + COMPLETE_TRIP', () => {
    const s = load('etms-no-show');
    expect(plannedEventsAt(s, 0).map((e) => e.type)).toEqual(['ARRIVED', 'BOARDED', 'DEPARTED']);
    expect(plannedEventsAt(s, 2)).toEqual([
      { type: 'ARRIVED', stopSeq: 2 },
      { type: 'REPORT_DELAY', reasonCode: 'TRAFFIC', etaMin: 5 },
      { type: 'NO_SHOW', passenger: 2, reasonCode: 'NOT_AT_PICKUP', afterNoShowWait: true },
      { type: 'DEPARTED', stopSeq: 2 },
    ]);
    expect(plannedEventsAt(s, 3).map((e) => `${e.type}${e.passenger ?? ''}`)).toEqual(['ARRIVED', 'DROPPED0', 'DROPPED1', 'COMPLETE_TRIP']);
  });

  it('offline window: stops fromStop … toStop − 1 are queued', () => {
    const s = load('etms-offline-driver');
    expect([0, 1, 2, 3].map((q) => offlineAt(s, q))).toEqual([true, true, false, false]);
    expect([0, 1, 2, 3].map((q) => offlineAt(load('etms-on-time'), q))).toEqual([false, false, false, false]);
  });

  it('rejects inconsistent scenarios', () => {
    const base = JSON.parse(readFileSync(join(DIR, 'etms-on-time.json'), 'utf8'));
    expect(() => parseScenario({ ...base, name: 'on-time' })).toThrow('etms-<kebab>');
    expect(() => parseScenario({ ...base, board: [{ stop: 0, passengers: [1] }] })).toThrow('own pickup');
    expect(() => parseScenario({ ...base, board: base.board.slice(0, 2) })).toThrow('every passenger');
    expect(() => parseScenario({ ...base, noShow: [{ stop: 2, passenger: 2, reasonCode: 'X' }] })).toThrow('both boarded');
    expect(() => parseScenario({ ...base, driverOffline: { fromStop: 1, toStop: 3 } })).toThrow('reconnect before the office');
    expect(() => parseScenario({ ...base, replay: { seed: 1, duplicateEvery: 0, batchSize: 3 } })).toThrow('replay');
  });

  it('R6 replay: shuffled, duplicated, never one id twice in a batch, every event at least once, reproducible', () => {
    const queue = Array.from({ length: 9 }, (_, i) => ({ clientEventId: `e${i}`, seq: i + 1 }));
    const o = { seed: 7, duplicateEvery: 2, batchSize: 3 };
    const batches = replayBatches(queue, o);
    const flat = batches.flat().map((e) => e.clientEventId);
    expect(flat).toHaveLength(9 + 4);
    expect(new Set(flat)).toEqual(new Set(queue.map((e) => e.clientEventId)));
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(3);
      expect(new Set(b.map((e) => e.clientEventId)).size).toBe(b.length);
    }
    expect(flat).not.toEqual([...queue.map((e) => e.clientEventId)]);
    expect(replayBatches(queue, o)).toEqual(batches);
    expect(replayBatches(queue, { ...o, seed: 8 })).not.toEqual(batches);
  });

  it('prng / shuffle are deterministic permutations', () => {
    const a = shuffle([1, 2, 3, 4, 5], prng(3));
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(shuffle([1, 2, 3, 4, 5], prng(3))).toEqual(a);
  });

  it('convergence key ignores the order rows come in', () => {
    const k1 = convergenceKey({ status: 'COMPLETED', stops: [{ seq: 1, status: 'DEPARTED' }, { seq: 0, status: 'DEPARTED' }], passengers: [{ index: 1, status: 'DROPPED' }, { index: 0, status: 'DROPPED' }] });
    const k2 = convergenceKey({ status: 'COMPLETED', stops: [{ seq: 0, status: 'DEPARTED' }, { seq: 1, status: 'DEPARTED' }], passengers: [{ index: 0, status: 'DROPPED' }, { index: 1, status: 'DROPPED' }] });
    expect(k1).toBe(k2);
    expect(k1).toBe('trip=COMPLETED stops=0:DEPARTED,1:DEPARTED pax=0:DROPPED,1:DROPPED');
  });
});
