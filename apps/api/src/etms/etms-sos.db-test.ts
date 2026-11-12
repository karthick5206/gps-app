/**
 * ETMS E5 WP 5.4 durable SOS on a real, freshly migrated PostgreSQL (and the real Valkey of TEST_REDIS_URL for the
 * outage / recovery round trip). Exit tests of doc 12 §8 WP 5.4:
 *  - one-transaction atomicity: incident + CREATED event + SAFETY outbox row commit together or not at all;
 *  - idempotent replay (same key → same receipt; same key + other body → 422; concurrent replays → one incident);
 *  - never dropped, never 429: presses while OPEN merge (bounded history); concurrent presses with different keys merge;
 *  - an SOS raised during a simulated Valkey outage is accepted, stays pending in PostgreSQL, and reaches the dispatcher
 *    channel after recovery with 0 lost (each exactly once); the direct-send fallback (fake push provider, local socket
 *    bus) delivers during the outage;
 *  - dispatcher ack (note required) / resolve with event, audit and outbox rows; relay claims are exclusive.
 * Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_<name>_test TEST_REDIS_URL=redis://localhost:6379/14 \
 *     npx jest --testRegex 'etms-sos\.db-test\.ts$' --runInBand
 * Synthetic data only (tag sos-…). Valkey keys / channels used here carry the test tag prefix and are deleted.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SOS_OUTBOX_TYPES } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import Redis from 'ioredis';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import type { PushMessage, PushProvider } from '../notifier/push';
import { dbDescribe } from '../test/scratch-db';
import { IncidentsService } from './safety/incidents.service';
import { SafetyOutboxRelayService } from './safety/safety-outbox-relay.service';
import { SOS_CHANNEL, sosLocalBus } from './safety/sos-bus';
import { SosDirectSender } from './safety/sos-direct-sender';
import { MAX_REPEAT_EVENTS, SosService } from './safety/sos.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const REDIS_URL = process.env.TEST_REDIS_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `sos-${Date.now().toString(36)}`;
const PREFIX = `test:${TAG}:`;

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: 'OK' }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { status: 0, code: `unexpected: ${String(e)}` };
      const r = e.getResponse() as { code?: string };
      return { status: e.getStatus(), code: r.code ?? `HTTP_${e.getStatus()}` };
    },
  );

/** Valkey stand-in over the real test Valkey: channel / stream names get the test prefix; `down` simulates an outage. */
class SwitchableValkey {
  down = false;
  constructor(private readonly real: Redis) {}
  readonly client = {
    publish: (ch: string, msg: string) => (this.down ? Promise.reject(new Error('ECONNREFUSED (simulated outage)')) : this.real.publish(PREFIX + ch, msg)),
    xadd: (key: string, ...args: (string | number)[]) => (this.down ? Promise.reject(new Error('ECONNREFUSED (simulated outage)')) : this.real.xadd(PREFIX + key, ...(args as [string]))),
  };
}

class FakePush implements PushProvider {
  readonly name = 'fake';
  readonly enabled = true;
  sent: { tokens: string[]; message: PushMessage }[] = [];
  send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return Promise.resolve({ sent: tokens.length, invalidTokens: [], error: null, ticketIds: tokens.map((_, i) => `t${i}`) });
  }
}

d(`ETMS E5 durable SOS on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const real = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }) : null;
  const sub = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }) : null;
  const valkey = new SwitchableValkey(real as Redis);
  const audit = new AuditService(prisma as never);
  const direct = new SosDirectSender(prisma as never);
  const fakePush = new FakePush();
  direct.useProvider(fakePush);
  /** No direct sender: during an outage nobody is reachable, so rows must wait for recovery. */
  const relayNoDirect = new SafetyOutboxRelayService(prisma as never, valkey as never);
  const relayDirect = new SafetyOutboxRelayService(prisma as never, valkey as never, direct);
  const sos = new SosService(prisma as never);
  const incidents = new IncidentsService(prisma as never, audit);

  const id = () => randomUUID();
  const w = { partner: id(), company: id(), other: id(), dispatcher: id(), role: id(), driverUser: id(), driver: id(), paxUsers: Array.from({ length: 22 }, id), profiles: Array.from({ length: 22 }, id), otherPax: id(), otherProfile: id() };
  const ctx = (userId: string, companyId = w.company, perms: Record<string, string[]> = {}) =>
    ({ userId, companyId, homeCompanyId: companyId, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const pax = (i: number) => ctx(w.paxUsers[i]!);
  const dispatcher = ctx(w.dispatcher, w.company, { etms_incidents: ['view', 'edit'] });
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const countsFor = async (userId: string) => ({
    incidents: await prisma.transportIncident.count({ where: { raiserUserId: userId } }),
    events: await prisma.transportIncidentEvent.count({ where: { incident: { raiserUserId: userId } } }),
    outbox: await prisma.outboxEvent.count({ where: { aggregateId: { in: (await prisma.transportIncident.findMany({ where: { raiserUserId: userId }, select: { id: true } })).map((r) => r.id) } } }),
  });
  /** Make every pending SAFETY row due now (instead of sleeping through the back-off). */
  const dueNow = () => prisma.outboxEvent.updateMany({ where: { publishedAt: null }, data: { availableAt: new Date(Date.now() - 1000) } });

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    for (const [c, n] of [[w.company, 'corp'], [w.other, 'other']]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${n}', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.dispatcher}', '${w.company}', 'Meena Desk', now())`);
    await sql(`INSERT INTO "Role" (id, "companyId", name, description, "isSystem", "dataScope", "updatedAt") VALUES ('${w.role}', '${w.company}', 'Transport dispatcher', 'Employee transport: dispatcher for assigned branches / sites', false, 'ASSIGNED', now())`);
    await sql(`INSERT INTO "RolePermission" ("roleId", menu, actions) VALUES ('${w.role}', 'etms_dispatch', ARRAY['view'])`);
    await sql(`INSERT INTO "UserRole" ("userId", "roleId") VALUES ('${w.dispatcher}', '${w.role}')`);
    await sql(`INSERT INTO "PushToken" (id, "userId", token, platform, "updatedAt") VALUES (gen_random_uuid(), '${w.dispatcher}', 'ExponentPushToken[${TAG}]', 'android', now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.driverUser}', '${w.company}', 'Synthetic Driver', now())`);
    await sql(`INSERT INTO "Driver" (id, "companyId", name, "userId", "isActive", "updatedAt") VALUES ('${w.driver}', '${w.company}', 'Synthetic Driver', '${w.driverUser}', true, now())`);
    for (const [i, u] of w.paxUsers.entries()) {
      await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${w.company}', 'Passenger ${i}', now())`);
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "userId", "employeeCode", "displayName", "updatedAt") VALUES ('${w.profiles[i]}', '${w.company}', '${u}', 'SOS${i}', 'Synthetic Passenger ${i}', now())`);
    }
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.otherPax}', '${w.other}', 'Other Passenger', now())`);
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "userId", "employeeCode", "displayName", "updatedAt") VALUES ('${w.otherProfile}', '${w.other}', '${w.otherPax}', 'OTH1', 'Other Passenger', now())`);
  });

  afterAll(async () => {
    if (real) {
      const keys = await real.keys(`${PREFIX}*`);
      if (keys.length) await real.del(...keys);
    }
    real?.disconnect();
    sub?.disconnect();
    await prisma.$disconnect();
  });

  it('raw SQL: pending outbox index, one OPEN SOS per raiser, CHECKs, purge-surviving FKs, backfill idempotent', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('OutboxEvent_pending_idx', 'TransportIncident_open_sos_raiser_key')`;
    expect(idx.find((i) => i.indexname === 'OutboxEvent_pending_idx')!.indexdef).toMatch(/\(class, "availableAt"\) WHERE \(\("publishedAt" IS NULL\) AND \("deadAt" IS NULL\)\)/);
    expect(idx.find((i) => i.indexname === 'TransportIncident_open_sos_raiser_key')!.indexdef).toMatch(/UNIQUE.*WHERE/);
    const fks = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`SELECT conname, confdeltype::text FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('"TransportIncident"'::regclass, '"TransportIncidentEvent"'::regclass, '"OutboxEvent"'::regclass) ORDER BY conname`;
    // No companyId FK at all; company / trip links are SET NULL (incidents survive a purge); history cascades with its incident.
    expect(Object.fromEntries(fks.map((f) => [f.conname, f.confdeltype]))).toEqual({
      TransportIncidentEvent_incidentId_fkey: 'c',
      TransportIncident_customerCompanyId_fkey: 'n',
      TransportIncident_providerCompanyId_fkey: 'n',
      TransportIncident_tripId_fkey: 'n',
    });
    const checks = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('"TransportIncident"'::regclass, '"TransportIncidentEvent"'::regclass, '"OutboxEvent"'::regclass) ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual([
      'OutboxEvent_attempts_check', 'OutboxEvent_published_dead_check',
      'TransportIncidentEvent_actorType_check', 'TransportIncidentEvent_kind_check',
      'TransportIncident_ack_check', 'TransportIncident_kind_check', 'TransportIncident_raiserType_check', 'TransportIncident_repeat_check', 'TransportIncident_resolution_check', 'TransportIncident_resolved_check', 'TransportIncident_status_check',
    ]);
    // A RESOLVED row without resolvedAt / outcome is refused by the database itself.
    await expect(sql(`INSERT INTO "TransportIncident" (id, "raiserType", "idempotencyKey", "requestHash", "raisedAt", status, "acknowledgedAt", "updatedAt") VALUES (gen_random_uuid(), 'PASSENGER', 'k', 'h', now(), 'RESOLVED', now(), now())`)).rejects.toThrow(/TransportIncident_resolved_check/);
    // Backfill: the seeded dispatcher template got etms_incidents view + edit; running the block again changes nothing.
    const block = /-- ETMS-E5-SOS-BACKFILL-BEGIN[\s\S]*-- ETMS-E5-SOS-BACKFILL-END/.exec(readFileSync(join(__dirname, '../../prisma/migrations/20261120090000_etms_incidents/migration.sql'), 'utf8'))![0];
    for (let i = 0; i < 2; i++) for (const stmt of block.replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await sql(stmt);
    const rows = await prisma.rolePermission.findMany({ where: { roleId: w.role } });
    expect(Object.fromEntries(rows.map((r) => [r.menu, r.actions]))).toEqual({ etms_dispatch: ['view'], etms_incidents: ['view', 'edit'] });
  });

  it('atomicity: incident, CREATED event and SAFETY outbox row commit together — or nothing at all', async () => {
    const key = id();
    const r = await sos.raisePassenger(pax(0), { note: 'help', fix: { lat: 13.05, lng: 80.25, accuracyM: 8, at: new Date().toISOString() } }, key);
    expect(r).toMatchObject({ created: true, replay: false, receipt: { status: 'RECEIVED_BY_SERVER', incidentStatus: 'OPEN', acknowledgement: null, merged: false, notify: 'QUEUED' } });
    const row = await prisma.transportIncident.findUniqueOrThrow({ where: { id: r.receipt.incidentId }, include: { events: true } });
    expect(row).toMatchObject({ raiserType: 'PASSENGER', customerCompanyId: w.company, providerCompanyId: null, idempotencyKey: key, fixLat: 13.05, status: 'OPEN' });
    expect(row.events.map((e) => e.kind)).toEqual(['CREATED']);
    const ob = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: row.id } });
    expect(ob).toMatchObject({ class: 'SAFETY', type: SOS_OUTBOX_TYPES.created, aggregateType: 'incident', companyId: w.company, publishedAt: null });
    expect(JSON.stringify(ob.payload)).not.toMatch(/help|13\.05|Synthetic/); // ids only in the outbox

    // Inject a failure into the outbox insert INSIDE the service transaction: the incident and its event roll back too.
    const failing = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop !== '$transaction') return Reflect.get(target, prop, recv);
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.$transaction((tx) => fn(new Proxy(tx, { get: (t, p, r2) => (p === 'outboxEvent' ? { create: () => Promise.reject(new Error('injected outbox failure')) } : Reflect.get(t, p, r2)) })));
      },
    });
    const before = await countsFor(w.paxUsers[1]!);
    await expect(new SosService(failing as never).raisePassenger(pax(1), { note: 'x' }, id())).rejects.toThrow('injected outbox failure');
    expect(await countsFor(w.paxUsers[1]!)).toEqual(before);
  });

  it('idempotent replay: same key → same receipt; other body → 422; 20 concurrent replays → one incident', async () => {
    const key = id();
    const body = { note: 'replay me', raisedAt: new Date(Date.now() - 60_000).toISOString() };
    const first = await sos.raisePassenger(pax(2), body, key);
    const again = await sos.raisePassenger(pax(2), body, key);
    expect(again).toMatchObject({ created: false, replay: true, receipt: { incidentId: first.receipt.incidentId, merged: false } });
    expect(await errOf(sos.raisePassenger(pax(2), { note: 'different' }, key))).toEqual({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    // An offline device replays a burst with one key (shuffled timing): exactly one incident, one outbox row.
    const key2 = id();
    const burst = await Promise.all(Array.from({ length: 20 }, () => sos.raisePassenger(pax(3), { note: 'burst' }, key2)));
    expect(new Set(burst.map((b) => b.receipt.incidentId)).size).toBe(1);
    expect(burst.filter((b) => b.created)).toHaveLength(1);
    expect(await countsFor(w.paxUsers[3]!)).toMatchObject({ incidents: 1, outbox: 1 });
  });

  it('never dropped, never 429: presses while OPEN merge (bounded history); concurrent different keys merge; after ack a new SOS is a new incident', async () => {
    const results = [];
    for (let i = 0; i < 60; i++) results.push(await sos.raisePassenger(pax(4), { note: `press ${i}` }, id()));
    expect(new Set(results.map((r) => r.receipt.incidentId)).size).toBe(1);
    expect(results.slice(1).every((r) => r.receipt.merged && !r.created)).toBe(true);
    const inc = await prisma.transportIncident.findUniqueOrThrow({ where: { id: results[0]!.receipt.incidentId } });
    expect(inc.repeatCount).toBe(59);
    expect(await prisma.transportIncidentEvent.count({ where: { incidentId: inc.id, kind: 'REPEATED' } })).toBe(MAX_REPEAT_EVENTS);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: inc.id } })).toBe(1); // merges do not re-notify
    // Two devices of one passenger at the same moment, different keys: one OPEN incident (partial unique + merge retry).
    const race = await Promise.all(Array.from({ length: 8 }, () => sos.raisePassenger(pax(5), {}, id())));
    expect(new Set(race.map((r) => r.receipt.incidentId)).size).toBe(1);
    expect(await prisma.transportIncident.count({ where: { raiserUserId: w.paxUsers[5] } })).toBe(1);
    // A replay of a merged press answers the same (merged) receipt.
    const k = id();
    const merged = await sos.raisePassenger(pax(5), { note: 'late' }, k);
    expect(await sos.raisePassenger(pax(5), { note: 'late' }, k)).toMatchObject({ replay: true, receipt: { incidentId: merged.receipt.incidentId, merged: true } });
    // A missing key is still accepted (server key) and merges.
    expect((await sos.raisePassenger(pax(4), {}, undefined)).receipt.incidentId).toBe(inc.id);
    // After an acknowledgement a new SOS is a new incident (and a new notification).
    await incidents.ack(dispatcher, inc.id, { note: 'Calling the passenger' });
    const fresh = await sos.raisePassenger(pax(4), { note: 'again' }, id());
    expect(fresh).toMatchObject({ created: true, receipt: { merged: false } });
    expect(fresh.receipt.incidentId).not.toBe(inc.id);
  });

  it('a foreign / unknown tripId never fails the SOS (tripLinked: false); a driver SOS is the operator side; identity is required', async () => {
    const r = await sos.raisePassenger(pax(6), { tripId: id() }, id());
    expect(r).toMatchObject({ created: true, receipt: { tripLinked: false } });
    expect((await prisma.transportIncident.findUniqueOrThrow({ where: { id: r.receipt.incidentId } })).tripId).toBeNull();
    const dr = await sos.raiseDriver(ctx(w.driverUser), { note: 'tyre burst' }, id());
    expect(await prisma.transportIncident.findUniqueOrThrow({ where: { id: dr.receipt.incidentId } })).toMatchObject({ raiserType: 'DRIVER', providerCompanyId: w.company, customerCompanyId: null, raiserDriverId: w.driver });
    expect(await errOf(sos.raiseDriver(pax(6), {}, id()))).toEqual({ status: 403, code: 'NOT_A_DRIVER' });
    expect(await errOf(sos.raisePassenger(ctx(w.dispatcher), {}, id()))).toEqual({ status: 403, code: 'NOT_A_PASSENGER' });
    // Receipts: own only.
    expect(await errOf(sos.receiptPassenger(pax(7), r.receipt.incidentId))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect((await sos.receiptPassenger(pax(6), r.receipt.incidentId)).incidentId).toBe(r.receipt.incidentId);
  });

  it('Valkey outage: 10 SOS accepted, pending in PostgreSQL, visible on the lane; after recovery all reach the dispatcher channel exactly once (0 lost)', async () => {
    if (!real || !sub) throw new Error('TEST_REDIS_URL is required for the outage test');
    // Drain anything earlier tests left pending, with Valkey up.
    await dueNow();
    while ((await relayNoDirect.run()).claimed) await dueNow();

    valkey.down = true;
    const raised: string[] = [];
    // The raise path never touches Valkey: every SOS is accepted during the outage.
    for (let i = 12; i < 22; i++) raised.push((await sos.raisePassenger(pax(i), { note: `outage ${i}` }, id())).receipt.incidentId);
    const uniq = [...new Set(raised)];
    expect(uniq).toHaveLength(10);
    for (let pass = 0; pass < 3; pass++) {
      await dueNow();
      const r = await relayNoDirect.run();
      expect(r.published + r.direct).toBe(0);
    }
    const pending = await prisma.outboxEvent.findMany({ where: { aggregateId: { in: uniq }, type: SOS_OUTBOX_TYPES.created } });
    expect(pending).toHaveLength(10);
    expect(pending.every((p) => p.publishedAt === null && p.attempts >= 3)).toBe(true);
    for (const p of pending) expect(p).toMatchObject({ attempts: expect.any(Number), lastError: expect.stringMatching(/Valkey down/) });
    // The dispatcher lane reads PostgreSQL: all incidents visible during the outage.
    const lane = await incidents.list(dispatcher, { open: '1', limit: '100' });
    for (const i of uniq) expect(lane.items.map((x) => x.id)).toContain(i);
    expect(lane.items.find((x) => x.id === uniq[uniq.length - 1])!.notify).toBe('QUEUED');

    // Recovery: the dispatcher channel (all API gateways) receives every pending SOS exactly once.
    const got: string[] = [];
    await sub.subscribe(PREFIX + SOS_CHANNEL);
    sub.on('message', (_ch, m) => got.push((JSON.parse(m) as { payload: { incidentId: string } }).payload.incidentId));
    valkey.down = false;
    await dueNow();
    const rec = await relayNoDirect.run();
    expect(rec.pending).toBe(0);
    await new Promise((res) => setTimeout(res, 300));
    const unpublished = await prisma.outboxEvent.count({ where: { aggregateId: { in: pending.map((p) => p.aggregateId) }, publishedAt: null } });
    expect(unpublished).toBe(0);
    const lost = pending.map((p) => p.aggregateId).filter((i) => got.filter((g) => g === i).length !== 1);
    expect(lost).toEqual([]); // 0 lost, none duplicated
    for (const p of pending) expect(await prisma.transportIncidentEvent.count({ where: { incidentId: p.aggregateId, kind: 'NOTIFY_PUBLISHED' } })).toBe(1);
    // The dispatcher's push row was queued in PostgreSQL during the outage and handed to the notifier stream on recovery.
    const logs = await prisma.notificationLog.findMany({ where: { refType: 'TRANSPORT_INCIDENT', refId: { in: pending.map((p) => p.aggregateId) } } });
    expect(logs.length).toBe(pending.length);
    expect(logs.every((l) => l.status === 'QUEUED' && l.recipient === `user:${w.dispatcher}` && !/Synthetic|outage/.test(l.body))).toBe(true);
    const stream = await real.xrange(`${PREFIX}vt:notify`, '-', '+');
    const streamed = stream.flatMap(([, f]) => JSON.parse(f[f.indexOf('logIds') + 1]!) as string[]);
    for (const l of logs) expect(streamed).toContain(l.id);
    // The raiser now sees an honest SENT_TO_DISPATCH (not "delivered", not acknowledged).
    expect((await sos.receiptPassenger(pax(21), raised[9]!))).toMatchObject({ notify: 'SENT_TO_DISPATCH', acknowledgement: null });
  });

  it('direct-send fallback during an outage: local dispatcher sockets and the push provider are reached without Valkey', async () => {
    valkey.down = true;
    let reached = 0;
    const off = sosLocalBus.register((m) => (m.payload.incidentId ? ++reached && 1 : 0));
    try {
      const r = await sos.raisePassenger(pax(10), { note: 'direct' }, id());
      await dueNow();
      const pass = await relayDirect.run();
      expect(pass.direct).toBeGreaterThanOrEqual(1);
      expect(reached).toBeGreaterThanOrEqual(1);
      const ev = await prisma.transportIncidentEvent.findFirstOrThrow({ where: { incidentId: r.receipt.incidentId, kind: 'NOTIFY_DIRECT' } });
      expect(ev.data).toMatchObject({ via: 'direct', pushSent: 1 });
      const log = await prisma.notificationLog.findFirstOrThrow({ where: { refType: 'TRANSPORT_INCIDENT', refId: r.receipt.incidentId } });
      expect(log).toMatchObject({ status: 'SENT', provider: 'fake' });
      const push = fakePush.sent.at(-1)!;
      expect(push.message).toMatchObject({ channelId: 'sos', data: { kind: 'SOS', notificationId: r.receipt.incidentId } });
      expect(JSON.stringify(push.message)).not.toMatch(/Synthetic|direct|13\.0/);
    } finally {
      off();
      valkey.down = false;
    }
  });

  it('dispatcher: ack needs a note, is audited and idempotent; resolve needs an outcome; the raiser sees the acknowledgement; relay claims are exclusive', async () => {
    const r = await sos.raisePassenger(pax(11), { note: 'ack me' }, id());
    const iid = r.receipt.incidentId;
    expect(await errOf(incidents.ack(dispatcher, iid, {}))).toEqual({ status: 400, code: 'NOTE_REQUIRED' });
    expect(await errOf(incidents.ack(ctx(w.otherPax, w.other, { etms_incidents: ['view', 'edit'] }), iid, { note: 'x' }))).toEqual({ status: 404, code: 'NOT_FOUND' });
    const acked = await incidents.ack(dispatcher, iid, { note: 'Called, passenger safe' });
    expect(acked).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'Meena Desk' });
    expect((await incidents.ack(dispatcher, iid, { note: 'again' })).status).toBe('ACKNOWLEDGED');
    expect(await prisma.auditLog.count({ where: { entity: 'TransportIncident', entityId: iid, action: 'UPDATE' } })).toBe(1);
    expect(await sos.receiptPassenger(pax(11), iid)).toMatchObject({ incidentStatus: 'ACKNOWLEDGED', acknowledgement: { by: 'Meena' } });
    expect(await errOf(incidents.resolve(dispatcher, iid, { note: 'done' }))).toEqual({ status: 400, code: 'VALIDATION' });
    const done = await incidents.resolve(dispatcher, iid, { resolution: 'ASSISTED', note: 'Escorted home' });
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: 'ASSISTED' });
    expect(done.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['CREATED', 'ACKNOWLEDGED', 'RESOLVED']));
    expect(await errOf(incidents.resolve(dispatcher, iid, { resolution: 'ASSISTED', note: 'x' }))).toEqual({ status: 409, code: 'INVALID_TRANSITION' });
    expect(await prisma.outboxEvent.count({ where: { aggregateId: iid } })).toBe(3); // created, acknowledged, resolved
    // Two relay instances at once: every row is published exactly once.
    await dueNow();
    const [a, b] = await Promise.all([relayNoDirect.run(), new SafetyOutboxRelayService(prisma as never, valkey as never).run()]);
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(3);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: iid, publishedAt: null } })).toBe(0);
    expect(await prisma.transportIncidentEvent.count({ where: { incidentId: iid, kind: 'NOTIFY_PUBLISHED' } })).toBe(1);
  });
});
