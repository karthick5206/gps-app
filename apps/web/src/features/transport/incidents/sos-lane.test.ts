import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MENUS, SOS_PUSH_TEXT, TRANSLATIONS, type IncidentListItem } from '@veetracer/shared';
import { bannerIncident, elapsed, isSosPayload, lanePollMs, newOpenIds, noteError, NOTIFY_LABEL, SOS_LANE_STRINGS, sortLane } from './sos-lane.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function item(over: Partial<IncidentListItem>): IncidentListItem {
  return {
    id: 'i',
    kind: 'SOS',
    status: 'OPEN',
    raiserType: 'PASSENGER',
    raiserLabel: 'Synthetic P.',
    tripId: null,
    tripLabel: null,
    vehiclePlate: null,
    raisedAt: '2026-11-12T10:00:00.000Z',
    receivedAt: '2026-11-12T10:00:00.000Z',
    lastFix: null,
    repeatCount: 0,
    notify: 'QUEUED',
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    ...over,
  };
}

test('lane order: OPEN first (longest waiting on top), then acknowledged newest first, resolved last', () => {
  const list = [
    item({ id: 'ack-old', status: 'ACKNOWLEDGED', receivedAt: '2026-11-12T09:00:00Z' }),
    item({ id: 'open-new', receivedAt: '2026-11-12T10:05:00Z' }),
    item({ id: 'res', status: 'RESOLVED', receivedAt: '2026-11-12T10:10:00Z' }),
    item({ id: 'open-old', receivedAt: '2026-11-12T10:01:00Z' }),
    item({ id: 'ack-new', status: 'ACKNOWLEDGED', receivedAt: '2026-11-12T09:30:00Z' }),
  ];
  assert.deepEqual(sortLane(list).map((i) => i.id), ['open-old', 'open-new', 'ack-new', 'ack-old', 'res']);
  assert.equal(bannerIncident(list)?.id, 'open-old');
  assert.equal(bannerIncident([item({ status: 'ACKNOWLEDGED' })]), null);
  assert.equal(bannerIncident(undefined), null);
});

test('polling: 15 s while the socket is down, 60 s safety net while it is up', () => {
  assert.equal(lanePollMs(false), 15_000);
  assert.equal(lanePollMs(true), 60_000);
});

test('ticking timer and first-seen OPEN incidents (siren once per incident)', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(elapsed('2026-11-12T10:00:00Z', t0 + 42_000), '0:42');
  assert.equal(elapsed('2026-11-12T10:00:00Z', t0 + 725_000), '12:05');
  assert.equal(elapsed('2026-11-12T10:00:00Z', t0 + 3_729_000), '1:02:09');
  assert.equal(elapsed('2026-11-12T10:00:00Z', t0 - 5_000), '0:00');
  assert.deepEqual(newOpenIds(new Set(['a']), [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', status: 'ACKNOWLEDGED' })]), ['b']);
});

test('socket payload guard and the client note rule', () => {
  assert.equal(isSosPayload({ incidentId: 'x', status: 'OPEN' }), true);
  assert.equal(isSosPayload({ status: 'OPEN' }), false);
  assert.equal(isSosPayload(null), false);
  assert.equal(noteError('   ', 500), 'A note is required: write what was done.');
  assert.equal(noteError('x'.repeat(501), 500), 'The note is too long.');
  assert.equal(noteError('Called the passenger', 500), null);
});

test('honest wording: nothing claims "delivered" or "help is on the way"', () => {
  for (const s of [...Object.values(NOTIFY_LABEL), SOS_PUSH_TEXT.title, SOS_PUSH_TEXT.body]) assert.doesNotMatch(s, /deliver|on the way/i);
});

test('menu: Incidents & SOS is an ETMS module menu at /transport/incidents', () => {
  const m = MENUS.find((x) => x.key === 'etms_incidents');
  assert.ok(m);
  assert.equal(m.path, '/transport/incidents');
  assert.ok(m.requires);
});

test('every string of the SOS lane, banner and bell is translated to Hindi and Tamil', () => {
  const files = [
    ...readdirSync(HERE).filter((f) => f.endsWith('.tsx')).map((f) => join(HERE, f)),
  ];
  assert.ok(files.length >= 2, 'lane + bell components');
  const keys = new Set<string>(SOS_LANE_STRINGS);
  keys.add('Incidents & SOS');
  keys.add(SOS_PUSH_TEXT.title);
  keys.add(SOS_PUSH_TEXT.body);
  const call = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(call)) keys.add(m[1]!.replace(/\\'/g, "'"));
  assert.ok(keys.size >= 30, `found ${keys.size} strings`);
  for (const lang of ['hi', 'ta'] as const) {
    const missing = [...keys].filter((k) => !TRANSLATIONS[lang][k]);
    assert.deepEqual(missing, [], `${lang} missing`);
    // Placeholders survive translation.
    for (const k of keys) for (const ph of k.match(/\{\{\w+\}\}/g) ?? []) assert.ok(TRANSLATIONS[lang][k]!.includes(ph), `${lang} ${k} keeps ${ph}`);
  }
});
