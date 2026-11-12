import { RELAY_IDLE_MAX_MS, SafetyOutboxRelayService } from './safety-outbox-relay.service';

/** QA B9: the relay poll backs off while no company has ETMS and nothing is due; ≤ 2 s once an ETMS company exists. */
describe('SAFETY relay back-off (QA B9)', () => {
  function relay(state: { etms: boolean; due: boolean }) {
    const calls: string[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('"Company"')) return calls.push('company'), [{ any: state.etms }];
        return calls.push('due'), [{ any: state.due }];
      }),
      $transaction: jest.fn(async () => (calls.push('claim'), [])),
    };
    const r = new SafetyOutboxRelayService(prisma as never, {} as never);
    let t = 1_000_000;
    r.now = () => t;
    return { r, calls, advance: (ms: number) => (t += ms) };
  }
  afterEach(() => {
    delete process.env.ETMS;
    delete process.env.ETMS_SOS_RELAY;
  });

  it('no ETMS company, nothing due: no claim transaction, checks back off 4 s → 8 s → … → 30 s', async () => {
    const { r, calls, advance } = relay({ etms: false, due: false });
    const checksAt: number[] = [];
    for (let s = 0; s <= 120; s += 2) {
      const before = calls.length;
      await r.tick();
      if (calls.length > before) checksAt.push(s);
      advance(2_000);
    }
    expect(calls).not.toContain('claim');
    // Gaps between checks grow and are capped at 30 s.
    const gaps = checksAt.slice(1).map((v, i) => v - checksAt[i]!);
    expect(gaps.slice(0, 4)).toEqual([4, 8, 16, 30]);
    expect(Math.max(...gaps) * 1000).toBeLessThanOrEqual(RELAY_IDLE_MAX_MS);
  });

  it('an ETMS company and nothing due: a single EXISTS every 2 s, no claim transaction', async () => {
    const { r, calls, advance } = relay({ etms: true, due: false });
    for (let i = 0; i < 5; i++) {
      await r.tick();
      advance(2_000);
    }
    expect(calls.filter((c) => c === 'due')).toHaveLength(5);
    expect(calls).not.toContain('claim');
  });

  it('due rows are claimed at once (also with no ETMS company left); a kick bypasses the back-off', async () => {
    const state = { etms: false, due: false };
    const { r, calls } = relay(state);
    await r.tick(); // backs off
    state.due = true;
    await r.tick(); // still inside the back-off window: nothing
    expect(calls).not.toContain('claim');
    await r.tick(true); // a kick (SOS raised in this process)
    expect(calls).toContain('claim');
    calls.length = 0;
    await r.tick(); // back-off reset: due rows are claimed on the next tick
    expect(calls).toEqual(['due', 'claim']);
  });

  it('ETMS_SOS_RELAY=off: nothing at all', async () => {
    process.env.ETMS_SOS_RELAY = 'off';
    const { r, calls } = relay({ etms: true, due: true });
    await r.tick();
    await r.tick(true);
    expect(calls).toEqual([]);
  });
});
