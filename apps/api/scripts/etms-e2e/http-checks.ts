/**
 * HTTP-level checks of the ETMS E3 gate (criterion `HTTP`): what the in-process DB suite cannot see because it calls
 * the services directly — the global JWT guard, the permission guard and TransportFeatureGuard in their real order,
 * the `Idempotent-Replay` header, 429 with `Retry-After`, and 404 for a tenant without the etms add-on.
 */
import { randomUUID } from 'node:crypto';
import { localDayKey, addDays } from '../../src/summarizer/tz';
import { Api, Recorder, sc, type Res } from './http-client';
import { HTTP_PASSWORD, type HttpAccounts } from './http-seed';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runHttpChecks(api: Api, acc: HttpAccounts, rec: Recorder): Promise<void> {
  const C = 'HTTP';
  const { ist } = acc;
  const login = (u: { email: string }) => api.login(u.email, HTTP_PASSWORD);
  const tok = {
    admin: await login(acc.users.admin),
    disp: await login(acc.users.dispNorth),
    fleet: await login(acc.users.fleet),
    heavy: await login(acc.users.heavy),
    ctrl: await login(acc.users.ctrlAdmin),
    off: await login(acc.users.offAdmin),
    pax: await login(acc.users.passengers[0]),
  };
  rec.check(C, 'synthetic users log in over HTTP (admin, North dispatcher, fleet user, CTRL / OFF admins, passenger)', Object.values(tok).every(Boolean));
  const day = addDays(localDayKey(Date.now(), 'Asia/Kolkata'), 2);
  const site = ist.sites[0];
  const body = (i: number, d = day) => ({ passengerId: ist.passengers[i].id, serviceDate: d, direction: 'IN', windowStart: `${d}T02:00:00.000Z`, windowEnd: `${d}T03:30:00.000Z`, drop: { lat: site.lat, lng: site.lng, poiId: site.id } });

  // ── Auth required on every ETMS route (sample) ──
  const sample: [string, string, unknown?][] = [
    ['GET', `/transport/dispatch/board?serviceDate=${day}`],
    ['POST', '/transport/dispatch/candidates', { bookingIds: [randomUUID()] }],
    ['POST', '/transport/dispatch/change-sets', { serviceDate: day, direction: 'IN', changes: [] }],
    ['GET', '/transport/dispatch/change-sets'],
    ['GET', '/transport/bookings'],
    ['POST', '/transport/bookings', body(0)],
    ['GET', `/transport/bookings/${randomUUID()}`],
    ['GET', '/transport/shifts'],
    ['GET', '/transport/schedules'],
    ['GET', '/transport/schedules/preview'],
    ['GET', '/transport/trips'],
    ['POST', `/transport/trips/${randomUUID()}/start`, {}],
    ['GET', '/me/transport/trips'],
    ['GET', '/me/transport/bookings'],
  ];
  const anon = await Promise.all(sample.map(async ([m, p, b]) => `${m} ${p.split('?')[0]} → ${(await api.call(null, m, p, b)).s}`));
  rec.check(C, `no token → 401 on ${sample.length} sampled ETMS routes`, anon.every((x) => x.endsWith('→ 401')), anon);
  const forged = await api.call('not.a.jwt', 'GET', '/transport/bookings');
  rec.check(C, 'malformed bearer token → 401', forged.s === 401, sc(forged));

  // ── Permission guard ──
  const fleet = await Promise.all([api.call(tok.fleet, 'GET', `/transport/dispatch/board?serviceDate=${day}`), api.call(tok.fleet, 'GET', '/transport/bookings'), api.call(tok.fleet, 'POST', '/transport/bookings', body(0), { 'idempotency-key': randomUUID() }), api.call(tok.fleet, 'GET', '/transport/trips')]);
  rec.check(C, 'fleet user without ETMS menus → 403 on board / bookings / create / trips', fleet.every((r) => r.s === 403), fleet.map(sc));
  const pax = await Promise.all([api.call(tok.pax, 'GET', `/transport/dispatch/board?serviceDate=${day}`), api.call(tok.pax, 'GET', '/transport/bookings'), api.call(tok.pax, 'POST', '/transport/dispatch/change-sets', { serviceDate: day, direction: 'IN', changes: [] }, { 'idempotency-key': randomUUID() })]);
  rec.check(C, 'passenger login → 403 on dispatcher endpoints', pax.every((r) => r.s === 403), pax.map(sc));
  const notPax = await api.call(tok.admin, 'GET', '/me/transport/trips');
  rec.check(C, 'admin without the etms_self menu on /me/transport/trips → 403 (permission guard, before the passenger check)', notPax.s === 403, sc(notPax));
  const own = await api.call(tok.pax, 'GET', '/me/transport/trips');
  rec.check(C, 'passenger login on /me/transport/trips → 200 (own, empty)', own.s === 200 && Array.isArray(own.b), sc(own));

  // ── Branch scope over HTTP: South booking vs the North dispatcher ──
  const south = await api.call(tok.admin, 'POST', '/transport/bookings', body(1), { 'idempotency-key': randomUUID() });
  const southId = south.b?.id as string;
  const dGet = await api.call(tok.disp, 'GET', `/transport/bookings/${southId}`);
  const dBoard = await api.call(tok.disp, 'GET', `/transport/dispatch/board?serviceDate=${day}`);
  rec.check(C, 'North dispatcher: South booking GET → 404 and absent from the board', south.s < 300 && dGet.s === 404 && dBoard.s === 200 && !(dBoard.b.queue as { id: string }[]).some((q) => q.id === southId), { create: sc(south), get: sc(dGet), board: dBoard.s });

  // ── etms-off tenant → 404 (TransportFeatureGuard), even with the Transport admin template ──
  const offRoutes: [string, string, unknown?][] = [
    ['GET', '/transport/bookings'],
    ['GET', '/transport/shifts'],
    ['GET', '/transport/schedules'],
    ['GET', `/transport/dispatch/board?serviceDate=${day}`],
    ['GET', '/transport/trips'],
    ['POST', '/transport/bookings', { ...body(0), passengerId: randomUUID() }],
  ];
  const offRes = await Promise.all(offRoutes.map(async ([m, p, b]) => `${m} ${p.split('?')[0]} → ${sc(await api.call(tok.off, m, p, b, { 'idempotency-key': randomUUID() }))}`));
  rec.check(C, 'etms-off tenant admin → 404 on bookings / shifts / schedules / board / trips / create', offRes.every((x) => /→ 404/.test(x)), offRes);

  // ── Another etms tenant ──
  const cross = await Promise.all([api.call(tok.ctrl, 'GET', `/transport/bookings/${southId}`), api.call(tok.ctrl, 'POST', '/transport/dispatch/candidates', { bookingIds: [southId] })]);
  rec.check(C, 'another etms tenant: GET / candidates of the booking → 404', cross.every((r) => r.s === 404), cross.map(sc));

  // ── Idempotent-Replay header ──
  const key = randomUUID();
  const b2 = body(2);
  const first = await api.call(tok.admin, 'POST', '/transport/bookings', b2, { 'idempotency-key': key });
  const again = await api.call(tok.admin, 'POST', '/transport/bookings', b2, { 'idempotency-key': key });
  const other = await api.call(tok.admin, 'POST', '/transport/bookings', { ...b2, windowEnd: `${day}T03:45:00.000Z` }, { 'idempotency-key': key });
  const noKey = await api.call(tok.admin, 'POST', '/transport/bookings', b2);
  rec.check(
    C,
    'booking create: first call no Idempotent-Replay header; replay → same id + `Idempotent-Replay: true`; other body 422; no key 400',
    first.s < 300 && !first.h.get('idempotent-replay') && again.s === first.s && again.h.get('idempotent-replay') === 'true' && again.b.id === first.b.id && other.s === 422 && noKey.s === 400,
    { first: [first.s, first.h.get('idempotent-replay')], again: [again.s, again.h.get('idempotent-replay'), again.b?.id === first.b?.id], other: sc(other), noKey: sc(noKey) },
  );
  const t0 = Date.parse(`${day}T02:10:00Z`);
  const cs = {
    serviceDate: day,
    direction: 'IN',
    changes: [
      { op: 'CREATE_TRIP', tempId: 't', objectId: ist.vehicles[0].id, driverId: null, plannedStart: new Date(t0).toISOString(), stops: [{ seq: 0, point: { lat: ist.passengers[2].homeLat, lng: ist.passengers[2].homeLng, label: 'Pickup' }, plannedArrival: new Date(t0).toISOString() }, { seq: 1, point: { lat: site.lat, lng: site.lng, label: 'Office', poiId: site.id }, plannedArrival: new Date(t0 + 3_600_000).toISOString() }] },
      { op: 'ADD_PASSENGER', tripId: 't', bookingId: first.b.id, pickupSeq: 0, dropSeq: 1 },
    ],
  };
  const ck = randomUUID();
  const c1 = await api.call(tok.admin, 'POST', '/transport/dispatch/change-sets', cs, { 'idempotency-key': ck });
  const c2 = await api.call(tok.admin, 'POST', '/transport/dispatch/change-sets', cs, { 'idempotency-key': ck });
  rec.check(C, 'change-set publish: replay with the same key → same change set + `Idempotent-Replay: true`', c1.s === 200 && !c1.h.get('idempotent-replay') && c2.s === 200 && c2.h.get('idempotent-replay') === 'true' && c2.b.changeSetId === c1.b.changeSetId, { c1: [sc(c1), c1.h.get('idempotent-replay')], c2: [sc(c2), c2.h.get('idempotent-replay')] });

  // ── 429 + Retry-After (60 creates / min / user) ──
  if (Date.now() % 60_000 > 40_000) await sleep(60_000 - (Date.now() % 60_000) + 300);
  const codes: string[] = [];
  let last: Res | null = null;
  for (let i = 0; i < 61; i++) {
    last = await api.call(tok.heavy, 'POST', '/transport/bookings', b2, { 'idempotency-key': randomUUID() });
    codes.push(sc(last));
  }
  const retry = Number(last?.h.get('retry-after'));
  const tally = codes.slice(0, 60).reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
  rec.check(C, '61st booking create in a minute → 429 RATE_LIMITED with a Retry-After header (1–60 s) and retryAfterSec in the body', codes[60] === '429 RATE_LIMITED' && retry >= 1 && retry <= 60 && last?.b?.retryAfterSec === retry, { first60: tally, call61: codes[60], retryAfter: last?.h.get('retry-after'), body: last?.b?.retryAfterSec });
  rec.check(C, 'the first 60 creates were not rate limited (409 BOOKING_DUPLICATE: same passenger / day)', tally['409 BOOKING_DUPLICATE'] === 60, tally);
}
