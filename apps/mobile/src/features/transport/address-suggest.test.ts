/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADDRESS_SUGGEST, createAddressSuggest, type SuggestState, type SuggestTimers } from './address-suggest.ts';

/** Manual clock: advance(ms) fires due timers in order. */
function fakeTimers() {
  let now = 0;
  let id = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: SuggestTimers = {
    setTimeout: (fn, ms) => {
      id += 1;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (i) => void due.delete(i as number),
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [k, v] of [...due.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (v.at <= now) {
        due.delete(k);
        v.fn();
      }
    }
    await new Promise((r) => setImmediate(r));
  };
  return { timers, advance, pending: () => due.size };
}

type Hit = { label: string };

function setup(search: (q: string, signal: AbortSignal) => Promise<Hit[]>) {
  const t = fakeTimers();
  const states: SuggestState<Hit>[] = [];
  const s = createAddressSuggest<Hit>({ search, onChange: (x) => states.push(x), timers: t.timers });
  return { ...t, s, states, last: () => states[states.length - 1] };
}

test('suggest: defaults are 350 ms, 3 characters, 6 items', () => {
  assert.deepEqual(ADDRESS_SUGGEST, { debounceMs: 350, minChars: 3, maxItems: 6 });
});

test('suggest: one request 350 ms after typing stops, not one per keystroke', async () => {
  const asked: string[] = [];
  const x = setup(async (q) => (asked.push(q), [{ label: `${q} Road` }]));
  for (const text of ['G', 'Gu', 'Gui', 'Guin', 'Guindy']) {
    x.s.input(text);
    await x.advance(100);
  }
  assert.deepEqual(asked, []);
  await x.advance(349 - 100);
  assert.deepEqual(asked, []);
  await x.advance(1);
  assert.deepEqual(asked, ['Guindy']);
  assert.deepEqual(x.last(), { status: 'DONE', query: 'Guindy', items: [{ label: 'Guindy Road' }], error: null });
});

test('suggest: under 3 characters nothing is asked (SHORT); empty is IDLE', async () => {
  const asked: string[] = [];
  const x = setup(async (q) => (asked.push(q), []));
  x.s.input('  ab ');
  await x.advance(1000);
  assert.equal(x.last().status, 'SHORT');
  x.s.input('   ');
  assert.equal(x.last().status, 'IDLE');
  assert.deepEqual(asked, []);
  assert.equal(x.pending(), 0);
});

test('suggest: a new search aborts the previous request and a late old answer is dropped', async () => {
  const signals: AbortSignal[] = [];
  const resolvers: ((v: Hit[]) => void)[] = [];
  const x = setup((_q, signal) => {
    signals.push(signal);
    return new Promise<Hit[]>((r) => resolvers.push(r));
  });
  x.s.input('Tidel');
  await x.advance(350);
  assert.equal(x.last().status, 'LOADING');
  x.s.input('Tidel Park');
  assert.equal(signals[0].aborted, true);
  await x.advance(350);
  assert.equal(signals.length, 2);
  resolvers[0]([{ label: 'old' }]);
  resolvers[1]([{ label: 'Tidel Park Office' }]);
  await x.advance(0);
  assert.deepEqual(x.last().items, [{ label: 'Tidel Park Office' }]);
  assert.equal(x.states.some((s) => s.items.some((i) => i.label === 'old')), false);
});

test('suggest: no results, rate limited (429), other errors; aborts are silent', async () => {
  let answer: () => Promise<Hit[]> = async () => [];
  const x = setup(() => answer());
  x.s.input('Nowhere');
  await x.advance(350);
  assert.equal(x.last().status, 'EMPTY');
  answer = async () => Promise.reject(Object.assign(new Error('Too many'), { status: 429 }));
  x.s.input('Nowhere 2');
  await x.advance(350);
  assert.equal(x.last().status, 'RATE_LIMITED');
  answer = async () => Promise.reject(Object.assign(new Error('boom'), { status: 503 }));
  x.s.input('Nowhere 3');
  await x.advance(350);
  assert.equal(x.last().status, 'ERROR');
  const before = x.states.length;
  answer = async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  x.s.input('Nowhere 4');
  await x.advance(350);
  assert.equal(x.last().status, 'LOADING');
  assert.equal(x.states.length, before + 2); // WAITING, LOADING; nothing for the abort
});

test('suggest: at most 6 items; reset (a pick) cancels a pending search; dispose stops everything', async () => {
  const asked: string[] = [];
  const x = setup(async (q) => (asked.push(q), Array.from({ length: 10 }, (_, i) => ({ label: `${q} ${i}` }))));
  x.s.input('Anna Nagar');
  await x.advance(350);
  assert.equal(x.last().items.length, 6);
  x.s.input('Anna Salai');
  x.s.reset();
  await x.advance(1000);
  assert.deepEqual(asked, ['Anna Nagar']);
  assert.equal(x.last().status, 'IDLE');
  x.s.input('Adyar');
  x.s.dispose();
  const n = x.states.length;
  await x.advance(1000);
  assert.deepEqual(asked, ['Anna Nagar']);
  assert.equal(x.states.length, n);
});
