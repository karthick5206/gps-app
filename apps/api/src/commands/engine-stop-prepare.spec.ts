import { ConflictException, HttpException } from '@nestjs/common';
import {
  CommandDispatch,
  ENGINE_STOP_MAX_FIX_AGE_SEC,
  ENGINE_STOP_MAX_SPEED_KPH,
  ENGINE_STOP_PREPARE_MAX_PER_USER,
  ENGINE_STOP_PREPARE_WAIT_SEC,
  freshPositionReason,
  PREPARE_FIX_MAX_FUTURE_SEC,
  PREPARE_FIX_TOLERANCE_SEC,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { hashPassword } from '../common/secrets';
import { CommandsService } from './commands.service';
import { PrepareState, prepareVerdict } from './engine-stop-prepare';

/**
 * Engine-stop "request a fresh position, then confirm" (owner decision on anti-theft-immobilisation-proposal.md,
 * Option 1). The preparation never sends / queues an engine stop, and the final send keeps every Q-01 rule.
 */
const T0 = Date.parse('2026-11-09T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('freshPositionReason (strictly after the request)', () => {
  const live = (over: Record<string, unknown> = {}) => ({ status: 'OFF', speedKph: 0, lat: 13, lng: 80, gpsValid: true, fixTime: iso(T0 + 2000), serverTime: iso(T0 + 3000), ...over });
  const now = T0 + 5000;

  it('accepts a valid GPS fix received after the request', () => {
    expect(freshPositionReason(live(), T0, now)).toBeNull();
  });
  it('refuses a position received before or exactly at the request time', () => {
    expect(freshPositionReason(live({ serverTime: iso(T0 - 1) }), T0, now)).toMatch(/Waiting/);
    expect(freshPositionReason(live({ serverTime: iso(T0) }), T0, now)).toMatch(/Waiting/);
  });
  it('refuses no live state / no server time', () => {
    expect(freshPositionReason(null, T0, now)).toMatch(/Waiting/);
    expect(freshPositionReason(live({ serverTime: null }), T0, now)).toMatch(/Waiting/);
  });
  it('refuses a position without a valid GPS fix (heartbeat-like / LBS / jump / re-upload) or unknown validity', () => {
    expect(freshPositionReason(live({ gpsValid: false }), T0, now)).toMatch(/valid GPS/);
    expect(freshPositionReason(live({ gpsValid: undefined }), T0, now)).toMatch(/valid GPS/);
    expect(freshPositionReason(live({ lat: null }), T0, now)).toMatch(/valid GPS/);
  });
  it('refuses an older stored fix received after the request', () => {
    expect(freshPositionReason(live({ fixTime: iso(T0 - (PREPARE_FIX_TOLERANCE_SEC + 1) * 1000) }), T0, now)).toMatch(/older/);
    expect(freshPositionReason(live({ fixTime: iso(T0 - PREPARE_FIX_TOLERANCE_SEC * 1000) }), T0, now)).toBeNull();
  });
  it('refuses a fix dated in the future', () => {
    expect(freshPositionReason(live({ fixTime: iso(now + (PREPARE_FIX_MAX_FUTURE_SEC + 1) * 1000) }), T0, now)).toMatch(/future/);
  });
});

describe('prepareVerdict', () => {
  const state: PrepareState = { requestId: 'r', userId: 'u', objectId: 'o', companyId: 'c', uniqueId: 'imei', commandId: 'cmd', requestedAt: iso(T0) };
  const fresh = { status: 'OFF', speedKph: 0, lat: 13, lng: 80, gpsValid: true, fixTime: iso(T0 + 2000), serverTime: iso(T0 + 3000) };

  it('ready when the fresh position passes the unchanged engine-stop rules; confirmBy = telemetry + 60 s', () => {
    const v = prepareVerdict(state, fresh, null, T0 + 5000);
    expect(v).toMatchObject({ status: 'ready', blockReason: null, freshPosition: { lat: 13, lng: 80, speedKph: 0 }, confirmBy: iso(T0 + 3000 + ENGINE_STOP_MAX_FIX_AGE_SEC * 1000) });
  });
  it('blocked (with the engineStopBlockReason text) when the fresh position is too fast', () => {
    const v = prepareVerdict(state, { ...fresh, status: 'RUNNING', speedKph: ENGINE_STOP_MAX_SPEED_KPH + 1 }, null, T0 + 5000);
    expect(v.status).toBe('blocked');
    expect(v.blockReason).toMatch(/moving at/);
  });
  it('blocked when the fresh position has meanwhile become older than 60 s', () => {
    const v = prepareVerdict(state, fresh, null, T0 + 3000 + (ENGINE_STOP_MAX_FIX_AGE_SEC + 1) * 1000);
    expect(v.status).toBe('blocked');
    expect(v.blockReason).toMatch(/s old/);
  });
  it('waiting until the wait time, then timeout', () => {
    const old = { ...fresh, fixTime: iso(T0 - 120_000), serverTime: iso(T0 - 100_000) };
    expect(prepareVerdict(state, old, null, T0 + 10_000)).toMatchObject({ status: 'waiting', blockReason: null, freshPosition: null });
    expect(prepareVerdict(state, old, null, T0 + (ENGINE_STOP_PREPARE_WAIT_SEC + 1) * 1000)).toMatchObject({ status: 'timeout', freshPosition: null });
  });
  it('not_connected when the position request failed (tracker disconnected)', () => {
    expect(prepareVerdict(state, undefined, 'FAILED', T0 + 1000).status).toBe('not_connected');
  });
});

// ── Service-level: fakes for Prisma, Valkey, live state and audit ──

const OBJECT = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';
const IMEI = '359647091912738';

function harness(opts: { connected?: boolean; subscribers?: number; protocol?: string } = {}) {
  const store = new Map<string, string>();
  const published: CommandDispatch[] = [];
  const queued: string[] = [];
  const rows: { id: string; type: string; payload: string; status: string; error?: string | null }[] = [];
  const audits: { entity: string; action: string; details?: unknown; after?: unknown }[] = [];
  let live: Record<string, unknown> | undefined;
  if (opts.connected !== false) store.set(`vt:conn:${IMEI}`, 'gw-1');

  const client = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
    publish: async (_c: string, m: string) => {
      published.push(JSON.parse(m) as CommandDispatch);
      return opts.subscribers ?? 1;
    },
    multi: () => {
      const m = { rpush: (_k: string, v: string) => (queued.push(v), m), expire: () => m, exec: async () => [] };
      return m;
    },
    mget: async () => [],
  };
  let passwordHash = '';
  const prisma = {
    trackedObject: {
      findFirst: async () => ({
        id: OBJECT,
        companyId: 'company-1',
        name: 'Truck 1',
        assignments: [{ device: { id: 'device-1', uniqueId: IMEI, model: { protocol: opts.protocol ?? 'GT06', capabilities: ['engine_cut'] } } }],
      }),
    },
    user: { findUnique: async () => ({ passwordHash }), findMany: async () => [{ id: USER, name: 'Owner' }] },
    deviceCommand: {
      create: async ({ data }: { data: { type: string; payload: string } }) => {
        const row = { id: `cmd-${rows.length + 1}`, ...data, status: 'QUEUED', response: null, error: null, createdAt: new Date(), sentAt: null, ackAt: null, expiresAt: new Date(), objectId: OBJECT, uniqueId: IMEI, createdById: USER };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string; error: string } }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    },
  };
  const liveState = { read: async () => new Map(live ? [[OBJECT, live]] : []) };
  const audit = { record: async (_ctx: unknown, e: { entity: string; action: string; details?: unknown; after?: unknown }) => void audits.push(e) };
  const service = new CommandsService(prisma as never, { client } as never, liveState as never, audit as never);
  const ctx = { userId: USER, companyId: 'company-1', homeCompanyId: 'company-1', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null } as unknown as AuthContext;
  return {
    service,
    ctx,
    store,
    published,
    queued,
    rows,
    audits,
    setLive: (l: Record<string, unknown> | undefined) => (live = l),
    setPassword: async (p: string) => (passwordHash = await hashPassword(p)),
  };
}

const freshLive = (requestedAt: string, over: Record<string, unknown> = {}) => {
  const t = Date.parse(requestedAt);
  return { objectId: OBJECT, status: 'OFF', speedKph: 0, lat: 13.08, lng: 80.27, ignition: false, satellites: 9, gpsValid: true, fixTime: iso(t + 500), serverTime: iso(t + 1000), ...over };
};

describe('CommandsService.prepareEngineStop', () => {
  it('not connected: sends nothing, queues nothing, creates no command, audits the refusal', async () => {
    const h = harness({ connected: false });
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    expect(r).toMatchObject({ status: 'not_connected', requestId: null, blockReason: expect.stringMatching(/never queued/) });
    expect(h.published).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(h.audits).toEqual([expect.objectContaining({ entity: 'EngineStopPrepare', details: expect.objectContaining({ result: 'not_connected' }) })]);
  });

  it('connected: sends ONLY the position request, flagged never-queued; never the engine stop', async () => {
    const h = harness();
    h.setLive(undefined);
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    expect(r.status).toBe('waiting');
    expect(h.published).toEqual([expect.objectContaining({ text: 'WHERE#', noQueue: true })]);
    expect(h.published[0].critical).toBeUndefined();
    expect(h.published.some((d) => d.text === 'RELAY,1#')).toBe(false);
    expect(h.queued).toEqual([]);
    expect(h.rows).toEqual([expect.objectContaining({ type: 'locate', payload: 'WHERE#' })]);
    expect(h.audits[0]).toMatchObject({ entity: 'EngineStopPrepare', action: 'CREATE', details: expect.objectContaining({ result: 'requested' }) });
  });

  it('Teltonika uses getrecord', async () => {
    const h = harness({ protocol: 'TELTONIKA' });
    await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    expect(h.published[0]).toMatchObject({ text: 'getrecord', noQueue: true });
  });

  it('gateway gone between check and publish: the request is FAILED, not queued', async () => {
    const h = harness({ subscribers: 0 });
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    expect(r.status).toBe('not_connected');
    expect(h.queued).toEqual([]);
    expect(h.rows[0]).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/never queued/) });
  });

  it('a position received before the request does not count; one received after it does', async () => {
    const h = harness();
    const before = new Date(Date.now() - 2000).toISOString();
    h.setLive(freshLive(before, { fixTime: before, serverTime: before }));
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    expect(r.status).toBe('waiting');
    h.setLive(freshLive(r.requestedAt!));
    const polled = await h.service.prepareEngineStop(h.ctx, OBJECT, { requestId: r.requestId! });
    expect(polled).toMatchObject({ status: 'ready', freshPosition: { lat: 13.08, lng: 80.27, speedKph: 0 } });
    expect(h.published).toHaveLength(1); // polling sends nothing
    expect(h.audits.at(-1)).toMatchObject({ action: 'UPDATE', details: expect.objectContaining({ result: 'ready' }) });
  });

  it('polling someone else’s request (other user) is refused', async () => {
    const h = harness();
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    await expect(h.service.prepareEngineStop({ ...h.ctx, userId: 'other' }, OBJECT, { requestId: r.requestId! })).rejects.toThrow(/expired/);
  });

  it('rate-limits position requests per user and vehicle', async () => {
    const h = harness();
    for (let i = 0; i < ENGINE_STOP_PREPARE_MAX_PER_USER; i++) await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    await expect(h.service.prepareEngineStop(h.ctx, OBJECT, {})).rejects.toBeInstanceOf(HttpException);
    expect(h.published).toHaveLength(ENGINE_STOP_PREPARE_MAX_PER_USER);
    expect(h.audits.at(-1)).toMatchObject({ details: expect.objectContaining({ result: 'rate_limited' }) });
  });

  it('API keys cannot use the preparation', async () => {
    const h = harness();
    await expect(h.service.prepareEngineStop({ ...h.ctx, apiKey: { id: 'k', name: 'k', scopes: ['write:commands:critical'] } }, OBJECT, {})).rejects.toThrow(/signed-in/);
  });
});

describe('CommandsService.send engine stop after preparation (Q-01 rules still run)', () => {
  async function prepared(over: Record<string, unknown> = {}) {
    const h = harness();
    await h.setPassword('Secret123');
    const r = await h.service.prepareEngineStop(h.ctx, OBJECT, {});
    h.setLive(freshLive(r.requestedAt!, over));
    return { h, requestId: r.requestId! };
  }

  it('sends the engine stop once (critical, never queued) and refuses a second use of the confirmation', async () => {
    const { h, requestId } = await prepared();
    const dto = await h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId });
    expect(dto.type).toBe('engine_stop');
    expect(h.published.at(-1)).toMatchObject({ text: 'RELAY,1#', critical: true });
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId })).rejects.toBeInstanceOf(ConflictException);
    expect(h.published.filter((d) => d.text === 'RELAY,1#')).toHaveLength(1);
    expect(h.audits.find((a) => a.entity === 'DeviceCommand')).toMatchObject({ after: expect.objectContaining({ type: 'engine_stop', prepareRequestId: requestId }) });
  });

  it('still refuses a moving vehicle (unchanged engineStopBlockReason)', async () => {
    const { h, requestId } = await prepared({ status: 'RUNNING', speedKph: ENGINE_STOP_MAX_SPEED_KPH + 5 });
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId })).rejects.toThrow(/moving at/);
    expect(h.published.some((d) => d.critical)).toBe(false);
  });

  it('still refuses an offline vehicle', async () => {
    const { h, requestId } = await prepared({ status: 'OFFLINE' });
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId })).rejects.toThrow(/offline/);
  });

  it('still refuses stale telemetry (older than 60 s) even with a confirmation', async () => {
    const { h, requestId } = await prepared();
    const old = new Date(Date.now() - (ENGINE_STOP_MAX_FIX_AGE_SEC + 5) * 1000).toISOString();
    h.setLive(freshLive(old, { fixTime: old, serverTime: old }));
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId })).rejects.toThrow(/s old/);
  });

  it('refuses when the latest position is no longer a valid fix from after the request', async () => {
    const { h, requestId } = await prepared({ gpsValid: false });
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId })).rejects.toThrow(/no longer current/);
    expect(h.published.some((d) => d.critical)).toBe(false);
  });

  it('a wrong password is refused before anything else', async () => {
    const { h, requestId } = await prepared();
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'wrong', prepareRequestId: requestId })).rejects.toThrow(/Password/);
  });

  it('not connected at send time: the engine stop is FAILED, never queued (unchanged)', async () => {
    const { h, requestId } = await prepared();
    h.store.delete(`vt:conn:${IMEI}`);
    const dto = await h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123', prepareRequestId: requestId });
    expect(dto.status).toBe('FAILED');
    expect(h.queued).toEqual([]);
  });

  it('prepareRequestId is refused for other commands', async () => {
    const { h, requestId } = await prepared();
    await expect(h.service.send(h.ctx, OBJECT, { type: 'engine_resume', prepareRequestId: requestId })).rejects.toThrow(/only applies to engine stop/);
  });

  it('the direct send without preparation keeps working under the same rules', async () => {
    const { h } = await prepared();
    await h.service.send(h.ctx, OBJECT, { type: 'engine_stop', password: 'Secret123' });
    expect(h.published.at(-1)).toMatchObject({ text: 'RELAY,1#', critical: true });
  });
});
