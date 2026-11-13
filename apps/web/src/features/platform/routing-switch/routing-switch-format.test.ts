import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRANSLATIONS, type RoutingReadinessDto } from '@veetracer/shared';
import { plannerErrorText } from '../../transport/planning/planner-format.ts';
import { companySwitchNote, missingItems, offReasonText, refusedReadiness, ROUTING_SWITCH_STRINGS } from './routing-switch-format.ts';

const readiness: RoutingReadinessDto = {
  ready: false,
  checkedAt: '2026-11-13T09:00:00Z',
  checks: [
    { key: 'env', ok: true, detail: null },
    { key: 'worker', ok: false, detail: 'No routing worker heartbeat' },
    { key: 'engine', ok: false, detail: 'GraphHopper is not healthy' },
  ],
};

test('v1.16 planner off text names who can switch it on', () => {
  assert.match(offReasonText('PLATFORM_OFF'), /ask your administrator/i);
  assert.match(offReasonText('COMPANY_OFF'), /Transport → Settings/);
  assert.match(offReasonText('ENV_OFF'), /emergency/);
  assert.equal(offReasonText(undefined), offReasonText('PLATFORM_OFF'));
});

test('company switch note follows the platform state', () => {
  assert.match(companySwitchNote(true, null), /working/);
  assert.match(companySwitchNote(true, 'PLATFORM_OFF'), /starts working when VeeTrax/);
  assert.match(companySwitchNote(false, 'PLATFORM_OFF'), /not switched automatic route planning on/);
  assert.match(companySwitchNote(false, 'COMPANY_OFF'), /by hand/);
  assert.match(companySwitchNote(true, 'ENV_OFF'), /emergency switch/);
});

test('a refused switch-ON carries the checklist; the toast lists the failing items in order', () => {
  assert.deepEqual(missingItems(refusedReadiness({ code: 'ROUTING_NOT_READY', readiness })), ['worker', 'engine']);
  assert.equal(refusedReadiness({ code: 'OTHER', readiness }), null);
  assert.equal(refusedReadiness(null), null);
  assert.equal(refusedReadiness({ code: 'ROUTING_NOT_READY', readiness: { checks: 'x' } }), null);
});

test('every v1.16 routing switch string (and the ROUTING_OFF job error) is translated to hi and ta', () => {
  const strings = [...ROUTING_SWITCH_STRINGS, plannerErrorText('ROUTING_OFF')!];
  for (const lang of ['hi', 'ta'] as const) assert.deepEqual(strings.filter((k) => !TRANSLATIONS[lang][k]), [], lang);
  assert.ok(ROUTING_SWITCH_STRINGS.length >= 40);
});
