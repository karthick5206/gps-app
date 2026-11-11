import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { miniMapOptions } from './mini-map-options.ts';

test('MiniMap keeps a compact attribution control (RR-08, OSM ODbL)', () => {
  const o = miniMapOptions(80.27, 13.08, 15);
  assert.deepEqual(o.attributionControl, { compact: true });
  assert.equal(o.interactive, false);
  assert.equal(o.zoom, 15);
});

test('MiniMap centre is [lng, lat]', () => {
  assert.deepEqual(miniMapOptions(80.27, 13.08, 15).center, [80.27, 13.08]);
});

test('no web map switches the attribution off', () => {
  const src = fileURLToPath(new URL('../../', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') && /attributionControl:\s*false/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(src);
  assert.deepEqual(offenders, []);
});
