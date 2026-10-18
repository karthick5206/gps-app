import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearField, EMPTY_ROW, isEmptyRow, resolveChain, sourceText, toPutBody, type Defaults } from './inheritance.ts';

const defaults: Defaults = {
  enabled: true,
  severity: 'WARNING',
  cooldownMin: 0,
  params: { toleranceKph: 5, limitKph: null },
  channels: { INFO: ['INAPP'], WARNING: ['INAPP', 'EMAIL'], CRITICAL: ['INAPP', 'EMAIL', 'SMS'] },
};

test('most specific non-null value wins per field', () => {
  const r = resolveChain(defaults, [
    { level: 'COMPANY', name: 'Demo', row: { ...EMPTY_ROW, params: { toleranceKph: 8 }, cooldownMin: 10 } },
    { level: 'BRANCH', name: 'Chennai', row: { ...EMPTY_ROW, params: { toleranceKph: 3 }, channels: { WARNING: ['INAPP'] } } },
    { level: 'OBJECT', name: 'TN01', row: { ...EMPTY_ROW, enabled: false } },
  ]);
  assert.equal(r.enabled, false);
  assert.deepEqual(r.sources.enabled, { level: 'OBJECT', name: 'TN01' });
  assert.equal(r.params.toleranceKph, 3);
  assert.deepEqual(r.sources['params.toleranceKph'], { level: 'BRANCH', name: 'Chennai' });
  assert.equal(r.params.limitKph, null);
  assert.equal(r.sources['params.limitKph'].level, 'DEFAULT');
  assert.equal(r.cooldownMin, 10);
  assert.equal(r.sources.cooldownMin.level, 'COMPANY');
  assert.deepEqual(r.channels.WARNING, ['INAPP']);
  assert.deepEqual(r.channels.CRITICAL, ['INAPP', 'EMAIL', 'SMS']);
  assert.equal(r.sources['channels.CRITICAL'].level, 'DEFAULT');
  assert.equal(r.severity, 'WARNING');
});

test('null fields and missing rows inherit', () => {
  const r = resolveChain(defaults, [{ level: 'COMPANY', row: null }, { level: 'BRANCH', row: { ...EMPTY_ROW, enabled: null, severity: null } }]);
  assert.equal(r.enabled, true);
  assert.equal(r.sources.enabled.level, 'DEFAULT');
  assert.equal(r.schedule, null);
});

test('enabled=false is a real override, not "inherit"', () => {
  const r = resolveChain(defaults, [{ level: 'COMPANY', row: { ...EMPTY_ROW, enabled: false } }]);
  assert.equal(r.enabled, false);
  assert.equal(r.sources.enabled.level, 'COMPANY');
});

test('sourceText', () => {
  assert.equal(sourceText({ level: 'DEFAULT' }, 'BRANCH'), 'Default');
  assert.equal(sourceText({ level: 'BRANCH', name: 'Chennai' }, 'BRANCH'), 'Set here');
  assert.equal(sourceText({ level: 'BRANCH', name: 'Chennai' }, 'OBJECT'), 'Inherited from Branch: Chennai');
  assert.equal(sourceText({ level: 'COMPANY' }, 'GROUP'), 'Inherited from Company');
  assert.equal(sourceText({ level: 'GROUP', name: 'Trucks' }, 'OBJECT'), 'Inherited from Group: Trucks');
  assert.equal(sourceText(undefined, 'OBJECT'), 'Default');
});

test('clearField and toPutBody', () => {
  const row = { ...EMPTY_ROW, params: { toleranceKph: 3, minDurationSec: 20 }, channels: { WARNING: ['EMAIL' as const] }, enabled: false };
  const a = clearField(row, 'params.toleranceKph');
  assert.deepEqual(a.params, { minDurationSec: 20 });
  assert.deepEqual(row.params, { toleranceKph: 3, minDurationSec: 20 }, 'original untouched');
  const b = clearField(clearField(clearField(a, 'params.minDurationSec'), 'channels.WARNING'), 'enabled');
  assert.equal(isEmptyRow(b), true);
  assert.deepEqual(toPutBody('BRANCH', 'b1', 'OVERSPEED', b), {
    level: 'BRANCH', targetId: 'b1', alertType: 'OVERSPEED', enabled: null, params: null, schedule: null, cooldownMin: null, severity: null, channels: null,
  });
  assert.equal(toPutBody('BRANCH', 'b1', 'OVERSPEED', row).enabled, false);
});
