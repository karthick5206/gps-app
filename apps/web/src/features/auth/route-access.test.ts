import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeAccess } from './route-access.ts';

test('ETMS page in a company with the add-on off is not found (never 403), whatever the role says', () => {
  assert.equal(routeAccess('etms_partners', 'view', { etms_partners: ['view'] }, []), 'notFound');
  assert.equal(routeAccess('etms_settings', 'view', {}, ['attendanceInsightsPlus']), 'notFound');
});

test('add-on on: grant decides between allow and forbidden', () => {
  assert.equal(routeAccess('etms_partners', 'view', { etms_partners: ['view'] }, ['etms']), 'allow');
  assert.equal(routeAccess('etms_partners', 'view', {}, ['etms']), 'forbidden');
});

test('ordinary GPS menus are unchanged', () => {
  assert.equal(routeAccess('live_map', 'view', { live_map: ['view'] }, []), 'allow');
  assert.equal(routeAccess('live_map', 'view', {}, []), 'forbidden');
});
