import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveObject } from '@veetracer/shared';
import { attentionItems } from './attention.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const obj = (id: string, status: LiveObject['status'], sinceMin: number | null, extra: Partial<LiveObject> = {}) =>
  ({ objectId: id, name: id, type: 'VEHICLE', status, statusSince: sinceMin === null ? null : ago(sinceMin), speedKph: 0, ...extra }) as LiveObject;

test('overspeed first (fastest first), then long idle (longest first), then recent offline (most recent first)', () => {
  const items = attentionItems(
    [
      obj('off-old', 'OFFLINE', 60 * 30),
      obj('off-2h', 'OFFLINE', 120),
      obj('off-10m', 'OFFLINE', 10),
      obj('idle-5', 'IDLE', 5),
      obj('idle-20', 'IDLE', 20),
      obj('idle-90', 'IDLE', 90),
      obj('os-84', 'OVERSPEED', 1, { speedKph: 84 }),
      obj('os-92', 'OVERSPEED', 2, { speedKph: 92 }),
      obj('run', 'RUNNING', 30),
    ],
    NOW,
  );
  assert.deepEqual(
    items.map((i) => i.object.objectId),
    ['os-92', 'os-84', 'idle-90', 'idle-20', 'off-10m', 'off-2h'],
  );
});

test('skips maintenance, people standing still and offline without a time', () => {
  const items = attentionItems([obj('m', 'OVERSPEED', 1, { inMaintenance: true }), obj('p', 'IDLE', 60, { type: 'PERSON' }), obj('x', 'OFFLINE', null)], NOW);
  assert.equal(items.length, 0);
});
