/// <reference types="node" />
/**
 * r114 mobile SOS fixes (QA B2 / B4, doc 09 §7.3): SOS context and offline identity, separate passenger / driver
 * queues, dispatcher SOS push routing, honest wording, en/hi/ta, and source guards for the wiring that has no
 * component test runner on this branch (jest-expo / RNTL are not installed).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRANSLATIONS, type SosReceipt } from '@veetracer/shared';
import type { KeyValueStore } from './event-queue.ts';
import { incidentLabelStrings } from './incidents/incident-labels.ts';
import { isSosPush, isTransportPush, sosPushTarget, transportPushTarget } from './push-target.ts';
import { transportRoles } from './roles.ts';
import { SOS_STAGE_TEXT } from './self-service.ts';
import {
  currentTrip,
  driverCurrentTrip,
  EMPTY_SOS_CONTEXT,
  mergeSosContext,
  offlineIdentityFor,
  parseOfflineIdentity,
  parseSosContext,
  passengerCurrentTrip,
  SOS_TRIP_AFTER_MS,
  SOS_TRIP_BEFORE_MS,
  sosTripIdAt,
} from './sos-context.ts';
import { SosQueue, type SosTransport } from './sos-queue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const USER = '33333333-3333-4333-8333-333333333333';
const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRIP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MIN = 60_000;
const NOW = Date.parse('2026-11-12T08:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function memStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

const receipt: SosReceipt = { incidentId: INC, status: 'RECEIVED_BY_SERVER', receivedAt: iso(NOW), incidentStatus: 'OPEN', acknowledgement: null, resolvedAt: null, merged: false, tripLinked: true, notify: 'QUEUED' };

// ───────────── queues ─────────────

test('passenger and driver SOS queues use separate keystore namespaces (passenger keys unchanged)', async () => {
  const store = memStore();
  const p = new SosQueue({ store, now: () => NOW });
  const d = new SosQueue({ store, namespace: 'dsos', now: () => NOW });
  await p.load(USER);
  await d.load(USER);
  await p.raise({ tripId: TRIP });
  await d.raise({});
  const keys = [...store.map.keys()];
  assert.ok(keys.some((k) => k === `vt.sos.${USER}.meta`), 'passenger meta key as in WP 5.3');
  assert.ok(keys.some((k) => k === `vt.dsos.${USER}.meta`), 'driver meta key');
  assert.equal(p.snapshot().items.length, 1);
  assert.equal(d.snapshot().items.length, 1);
  assert.equal(d.snapshot().latest?.tripId, null);
  assert.throws(() => new SosQueue({ store, namespace: 'vt.x' }), /namespace/);
});

test('an offline SOS stays queued (never dropped) and is delivered once the network returns', async () => {
  const store = memStore();
  let t = NOW;
  const q = new SosQueue({ store, namespace: 'dsos', now: () => t });
  await q.load(USER);
  let online = false;
  const sent: string[] = [];
  const transport: SosTransport = {
    async send(item) {
      if (!online) throw new Error('network');
      sent.push(item.clientIncidentId);
      return receipt;
    },
  };
  const item = await q.raise({ tripId: TRIP });
  await q.drain(transport, true);
  assert.equal(q.snapshot().latest?.state, 'PENDING');
  // Cold start of a new app process: the row is still there and due at once.
  const q2 = new SosQueue({ store, namespace: 'dsos', now: () => t });
  await q2.load(USER);
  assert.equal(q2.snapshot().pending, 1);
  assert.equal(q2.due(), true);
  online = true;
  t += 20_000;
  await q2.drain(transport);
  assert.deepEqual(sent, [item.clientIncidentId]);
  assert.equal(q2.snapshot().latest?.state, 'RECEIVED');
});

// ───────────── SOS context ─────────────

test('current trip: a running trip wins; otherwise the window start − 30 min … end + 60 min; finished never', () => {
  const trip = (id: string, startMin: number, endMin: number, derivedState = 'PUBLISHED') => ({ id, start: iso(NOW + startMin * MIN), end: iso(NOW + endMin * MIN), derivedState });
  assert.equal(currentTrip([trip(TRIP, 20, 80)], NOW)?.tripId, TRIP, 'starts in 20 min: inside the 30 min lead');
  assert.equal(currentTrip([trip(TRIP, 40, 80)], NOW), null, 'starts in 40 min: not yet');
  assert.equal(currentTrip([trip(TRIP, -120, -50)], NOW)?.tripId, TRIP, 'ended 50 min ago: still inside the 60 min tail');
  assert.equal(currentTrip([trip(TRIP, -180, -70)], NOW), null, 'ended 70 min ago');
  assert.equal(currentTrip([trip(TRIP, -30, 30, 'COMPLETED')], NOW), null, 'finished trips are never attached');
  assert.equal(currentTrip([trip(TRIP, 20, 80), trip(TRIP2, 300, 400, 'IN_PROGRESS')], NOW)?.tripId, TRIP2, 'a running trip wins');
  assert.equal(currentTrip([trip('not-a-uuid', -10, 10)], NOW), null, 'only UUID ids are ever put in an SOS body');
  const c = currentTrip([trip(TRIP, -10, 50)], NOW)!;
  assert.equal(c.until, NOW + 50 * MIN + SOS_TRIP_AFTER_MS);
  assert.equal(SOS_TRIP_BEFORE_MS, 30 * MIN);
});

test('passenger / driver DTO adapters use the planned times', () => {
  const p = passengerCurrentTrip([{ id: TRIP, window: { start: iso(NOW - 60 * MIN), end: iso(NOW + 60 * MIN) }, plannedStart: iso(NOW + 10 * MIN), plannedEnd: iso(NOW + 70 * MIN), derivedState: 'PUBLISHED' }], NOW);
  assert.equal(p?.tripId, TRIP);
  const d = driverCurrentTrip([{ id: TRIP2.toUpperCase(), plannedStart: iso(NOW - 5 * MIN), plannedEnd: iso(NOW + 40 * MIN), derivedState: 'DRIVER_ACKNOWLEDGED' }], NOW);
  assert.equal(d?.tripId, TRIP2, 'lower-cased');
});

test('the remembered trip is attached only until it expires', () => {
  assert.equal(sosTripIdAt({ tripId: TRIP, until: NOW + 1 }, NOW), TRIP);
  assert.equal(sosTripIdAt({ tripId: TRIP, until: NOW - 1 }, NOW), null);
  assert.equal(sosTripIdAt(EMPTY_SOS_CONTEXT, NOW), null);
  assert.equal(sosTripIdAt(null, NOW), null);
});

test('a stored context is validated before use (damaged or tampered rows are ignored)', () => {
  assert.deepEqual(parseSosContext(JSON.stringify({ tripId: TRIP, until: NOW, deskPhone: '+91 80 1234 5678' })), { tripId: TRIP, until: NOW, deskPhone: '+91 80 1234 5678' });
  assert.deepEqual(parseSosContext(JSON.stringify({ tripId: '../../x', until: NOW, deskPhone: 'javascript:alert(1)' })), EMPTY_SOS_CONTEXT);
  assert.deepEqual(parseSosContext(JSON.stringify({ tripId: TRIP })), EMPTY_SOS_CONTEXT, 'a trip without an expiry is never attached');
  assert.deepEqual(parseSosContext('{not json'), EMPTY_SOS_CONTEXT);
  assert.deepEqual(parseSosContext(null), EMPTY_SOS_CONTEXT);
});

test('context merge: unchanged → null (no keystore write); clearing the trip clears its expiry', () => {
  const a = { tripId: TRIP, until: NOW, deskPhone: '112' };
  assert.equal(mergeSosContext(a, { tripId: TRIP, until: NOW }), null);
  assert.deepEqual(mergeSosContext(a, { tripId: null }), { tripId: null, until: null, deskPhone: '112' });
  assert.deepEqual(mergeSosContext(a, { deskPhone: 'bad phone' }), { tripId: TRIP, until: NOW, deskPhone: null });
});

test('offline identity: kept only for users with an SOS section, validated on read', () => {
  assert.deepEqual(offlineIdentityFor(USER, { passenger: true, driver: false }), { userId: USER, passenger: true, driver: false });
  assert.equal(offlineIdentityFor(USER, { passenger: false, driver: false }), null, 'fleet-only users keep the old sign-in behaviour');
  assert.equal(offlineIdentityFor(null, { passenger: true, driver: true }), null);
  assert.deepEqual(parseOfflineIdentity(JSON.stringify({ userId: USER, passenger: false, driver: true })), { userId: USER, passenger: false, driver: true });
  assert.equal(parseOfflineIdentity(JSON.stringify({ userId: '../x', passenger: true })), null);
  assert.equal(parseOfflineIdentity(JSON.stringify({ userId: USER })), null);
  assert.equal(parseOfflineIdentity('nope'), null);
});

// ───────────── B2: dispatcher SOS push ─────────────

const SOS_PUSH = { transport: true, sos: true, kind: 'SOS', tripId: TRIP, notificationId: INC };

test('B2: a dispatcher SOS push never opens a passenger / driver trip', () => {
  assert.equal(isTransportPush(SOS_PUSH), true);
  assert.equal(isSosPush(SOS_PUSH), true);
  assert.equal(isSosPush({ kind: 'TRIP_DELAYED', tripId: TRIP }), false);
  for (const roles of [
    { passenger: true, driver: false },
    { passenger: false, driver: true },
    { passenger: true, driver: true, fleet: true },
  ]) {
    const target = transportPushTarget(SOS_PUSH, roles);
    assert.ok(!target?.includes('/trip/'), `${JSON.stringify(roles)} → ${target}`);
  }
});

test('B2: incidents access → read-only incident screen; otherwise the notification list', () => {
  assert.equal(transportPushTarget(SOS_PUSH, { passenger: true, driver: false, incidents: true, fleet: true }), `/transport-incident/${INC}`);
  assert.equal(transportPushTarget({ ...SOS_PUSH, notificationId: INC.toUpperCase() }, { passenger: false, driver: false, incidents: true, fleet: true }), `/transport-incident/${INC}`);
  assert.equal(transportPushTarget(SOS_PUSH, { passenger: true, driver: false, incidents: false, fleet: true }), '/alerts');
  assert.equal(transportPushTarget(SOS_PUSH, { passenger: false, driver: true }), '/driver-inbox');
  assert.equal(transportPushTarget(SOS_PUSH, { passenger: true, driver: false }), '/commute/notices');
  assert.equal(transportPushTarget(SOS_PUSH, { passenger: false, driver: false }), null);
  // A malformed incident id never builds a route, even with incidents access.
  assert.equal(sosPushTarget({ ...SOS_PUSH, notificationId: '../../etc' }, { passenger: false, driver: false, incidents: true, fleet: true }), '/alerts');
  // `kind: 'SOS'` alone (no `sos` flag) is enough.
  assert.equal(transportPushTarget({ kind: 'SOS', notificationId: INC }, { passenger: false, driver: false, incidents: true }), `/transport-incident/${INC}`);
  // Trip pushes are unchanged.
  assert.equal(transportPushTarget({ kind: 'TRIP_DELAYED', tripId: TRIP, notificationId: INC }, { passenger: true, driver: false, incidents: true, fleet: true }), `/commute/trip/${TRIP}`);
});

test('B2: incidents role = etms add-on + etms_incidents:view', () => {
  const me = (permissions: Record<string, string[]>, features = ['etms']) => ({ permissions, company: { features } }) as Parameters<typeof transportRoles>[0];
  assert.equal(transportRoles(me({ etms_incidents: ['view'] })).incidents, true);
  assert.equal(transportRoles(me({ etms_incidents: ['view'] }, [])).incidents, false);
  assert.equal(transportRoles(me({ live_map: ['view'] })).incidents, false);
});

test('B2: the tapped SOS push is not marked read in an inbox (its notificationId is the incident id)', () => {
  const push = read('features/notifications/push.ts');
  assert.match(push, /!isSosPush\(data\) && typeof data\.notificationId === 'string'/);
});

// ───────────── wording + i18n ─────────────

const NEW_UI_FILES = [
  'features/transport/SosScreen.tsx',
  'features/transport/passenger/SosPanel.tsx',
  'features/transport/passenger/TripScreen.tsx',
  'features/transport/passenger/CommuteHome.tsx',
  'features/transport/driver/DutyHome.tsx',
  'features/transport/driver/DriverTripScreen.tsx',
  'features/transport/incidents/IncidentScreen.tsx',
  'app/offline-sos.tsx',
  'app/_layout.tsx',
];

function uiStrings(): string[] {
  const re = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
  const keys = new Set<string>(incidentLabelStrings());
  for (const f of NEW_UI_FILES) {
    const src = read(f);
    for (let m = re.exec(src); m; m = re.exec(src)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  return [...keys];
}

test('honest wording: no SOS text promises help before a dispatcher acknowledges', () => {
  const texts = [...uiStrings(), ...Object.values(SOS_STAGE_TEXT).flatMap((s) => [s.label, s.body])];
  for (const s of texts) assert.doesNotMatch(s, /help (is|will be) (coming|on (the|its) way)|help is on|delivered to (the )?(desk|dispatcher)/i, s);
  // Only an acknowledgement is shown as acknowledged.
  assert.equal(SOS_STAGE_TEXT.RECEIVED.body, 'VeeTrax received your SOS. It has not been acknowledged by the desk yet.');
});

test('i18n: every new / changed mobile SOS string has hi and ta, placeholders intact', () => {
  const keys = uiStrings();
  assert.ok(keys.length > 40, `only ${keys.length} strings found`);
  for (const lang of ['hi', 'ta'] as const) {
    assert.deepEqual(
      keys.filter((k) => !TRANSLATIONS[lang][k]),
      [],
      `${lang} missing`,
    );
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
    for (const k of keys) assert.equal(ph(TRANSLATIONS[lang][k]), ph(k), `${lang}: ${k}`);
  }
});

// ───────────── wiring guards (no component runner on this branch) ─────────────

test('B4: the SOS header button is on every passenger / driver tab and stack screen', () => {
  assert.match(read('features/transport/shell.tsx'), /headerRight: sosHeaderRight\(sos\)/);
  assert.match(read('app/(passenger)/_layout.tsx'), /<ShellTabs sos="passenger">/);
  assert.match(read('app/(driver)/_layout.tsx'), /<ShellTabs sos="driver">/);
  const layout = read('app/_layout.tsx');
  const screens = [...layout.matchAll(/<Stack\.Screen name="((?:commute|duty)\/[^"]+)" options=\{\{([^}]*)\}\} \/>/g)];
  assert.ok(screens.length >= 13, `found ${screens.length}`);
  for (const [, name, opts] of screens) {
    if (name.endsWith('/sos')) continue;
    assert.match(opts, name.startsWith('commute') ? /\.\.\.PASSENGER_SOS/ : /\.\.\.DRIVER_SOS/, name);
  }
  assert.match(layout, /name="commute\/sos"/);
  assert.match(layout, /name="duty\/sos"/);
  assert.match(layout, /<Stack\.Protected guard=\{status === 'offline'\}>\s*<Stack\.Screen name="offline-sos"/);
  assert.match(layout, /guard=\{signedIn && !!roles\?\.incidents\}>\s*<Stack\.Screen name="transport-incident\/\[id\]"/);
});

test('B4: the passenger trip screen no longer needs an online policy to show SOS', () => {
  const trip = read('features/transport/passenger/TripScreen.tsx');
  assert.match(trip, /const sosEnabled = policy\?\.sos !== false;/);
  assert.doesNotMatch(trip, /\{policy\?\.sos \?/);
});

test('driver SOS goes to the driver route with its own queue; no location module is used', () => {
  const store = read('features/transport/sos-store.ts');
  assert.match(store, /createChannel\('driver', 'dsos', SOS_ROUTES\.driver\)/);
  assert.match(store, /createChannel\('passenger', 'sos', SOS_ROUTES\.passenger\)/);
  for (const f of ['features/transport/sos-store.ts', 'features/transport/SosScreen.tsx', 'app/offline-sos.tsx']) assert.doesNotMatch(read(f), /from 'expo-location'/, f);
  const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies['expo-location'], undefined);
});
