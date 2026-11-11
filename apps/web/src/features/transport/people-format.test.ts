import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSENT_PURPOSES, PASSENGER_IMPORT_COLUMNS, PASSENGER_IMPORT_MAX_BYTES, type AuditLogDto, type ConsentNoticeDto, type ConsentRecordDto, type PassengerDto } from '@veetracer/shared';
import {
  canGrantWithNotice,
  committableRows,
  consentPurposeLabel,
  consentRows,
  consentStatus,
  consentTimeline,
  countCsvDataRows,
  csvCell,
  formatCoords,
  formatRowSelection,
  geocodeMatchBadge,
  historyDetails,
  historyEntrySummary,
  historyFieldRows,
  importFileProblem,
  isApproximate,
  locationStatus,
  LOGIN_REMOVAL_TEXT,
  noticeFor,
  noticeVersions,
  parseLatLng,
  parseRowSelection,
  parseSeats,
  passengerImportTemplate,
  PASSENGER_IMPORT_EXAMPLE,
  peopleErrorKind,
  routingConsentBadge,
  validateEmergencyContacts,
  validateNoticeDraft,
} from './people-format.ts';

test('CSV template carries exactly the server columns, in order, with a BOM and CRLF', () => {
  const tpl = passengerImportTemplate();
  assert.ok(tpl.startsWith('﻿'));
  assert.ok(tpl.endsWith('\r\n'));
  assert.equal(tpl.slice(1).trim(), PASSENGER_IMPORT_COLUMNS.join(','));
  assert.equal(
    tpl.slice(1).trim(),
    'employee_code,name,mobile,email,home_address,home_lat,home_lng,office,default_stop,branch,wheelchair,accessibility_notes,active',
  );
  assert.equal(countCsvDataRows(tpl), 0);
  assert.deepEqual(Object.keys(PASSENGER_IMPORT_EXAMPLE), [...PASSENGER_IMPORT_COLUMNS]);
});

test('csvCell quotes separators, quotes and line breaks', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(csvCell(null), '');
});

test('countCsvDataRows ignores blank lines and keeps quoted line breaks in one row', () => {
  assert.equal(countCsvDataRows('employee_code,name\nE1,A\n\nE2,B\n'), 2);
  assert.equal(countCsvDataRows('employee_code,name\r\nE1,"two\nlines"\r\nE2,B'), 2);
  assert.equal(countCsvDataRows('employee_code,name\n,,\n'), 0);
  assert.equal(countCsvDataRows(''), 0);
});

test('importFileProblem enforces .csv and the 5 MB limit', () => {
  assert.equal(importFileProblem({ name: 'staff.csv', size: 100, type: 'text/csv' }), null);
  assert.equal(importFileProblem({ name: 'staff.CSV', size: 100, type: '' }), null);
  assert.equal(importFileProblem({ name: 'staff.xlsx', size: 100, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'NOT_CSV');
  assert.equal(importFileProblem({ name: 'staff.csv', size: PASSENGER_IMPORT_MAX_BYTES + 1 }), 'TOO_LARGE');
  assert.equal(importFileProblem({ name: 'staff.csv', size: PASSENGER_IMPORT_MAX_BYTES }), null);
  assert.equal(importFileProblem({ name: 'staff.csv', size: 0 }), 'EMPTY');
});

test('parseRowSelection accepts "1,3-5" like the server and rejects bad parts', () => {
  assert.deepEqual(parseRowSelection('1,3-5'), { rows: [1, 3, 4, 5] });
  assert.deepEqual(parseRowSelection(' 5 , 1 - 2 ,, 2 '), { rows: [1, 2, 5] });
  assert.deepEqual(parseRowSelection(''), { rows: [] });
  assert.deepEqual(parseRowSelection('a'), { error: 'Invalid row selection', part: 'a' });
  assert.deepEqual(parseRowSelection('5-3'), { error: 'Invalid row range', part: '5-3' });
  assert.deepEqual(parseRowSelection('0'), { error: 'Invalid row range', part: '0' });
  assert.deepEqual(parseRowSelection('1-20', 10), { error: 'Invalid row range', part: '1-20' });
});

test('formatRowSelection compacts runs and round-trips with the parser', () => {
  assert.equal(formatRowSelection([5, 3, 4, 1, 9, 10]), '1,3-5,9,10');
  assert.equal(formatRowSelection([]), '');
  assert.equal(formatRowSelection([7, 7, 0, -1]), '7');
  const rows = [1, 2, 3, 8, 11, 12, 13, 14, 40];
  const back = parseRowSelection(formatRowSelection(rows));
  assert.deepEqual(back, { rows });
});

test('committableRows keeps only CREATE / UPDATE rows', () => {
  assert.deepEqual(
    committableRows([
      { row: 1, action: 'CREATE' },
      { row: 2, action: 'ERROR' },
      { row: 3, action: 'UNCHANGED' },
      { row: 4, action: 'UPDATE' },
    ]),
    [1, 4],
  );
});

const base: Pick<PassengerDto, 'projection' | 'needsLocation' | 'hasHomeLocation' | 'defaultStop' | 'home' | 'isActive'> = {
  projection: 'FULL',
  needsLocation: false,
  hasHomeLocation: true,
  defaultStop: null,
  home: { address: '12 Anna Salai', lat: 13.060412, lng: 80.249679, source: 'PIN', confidence: null },
  isActive: true,
};

test('locationStatus follows the server view model and never fakes precision', () => {
  assert.equal(locationStatus(base).kind, 'HOME');
  // M3: a dispatcher never gets the home point; a FULL list row has no coordinates but the admin knows a pin is set.
  assert.equal(locationStatus({ ...base, projection: 'STANDARD', home: { ...base.home!, address: null, lat: null, lng: null } }).kind, 'HOME_HIDDEN');
  assert.equal(locationStatus({ ...base, home: { ...base.home!, address: null, lat: null, lng: null } }).kind, 'HOME');
  assert.equal(locationStatus({ ...base, projection: 'MINIMAL', home: null }).kind, 'HOME_HIDDEN');
  assert.equal(locationStatus({ ...base, needsLocation: true, hasHomeLocation: false, home: null }).label, 'Needs location');
  assert.equal(locationStatus({ ...base, defaultStop: { id: 's', name: 'Metro gate', lat: 1, lng: 1 } }).kind, 'STOP');
  assert.equal(locationStatus({ ...base, hasHomeLocation: false, home: { address: null, lat: null, lng: null, source: null, confidence: null } }).kind, 'NONE');
});

test('formatCoords shows 6 decimals for FULL and the 4 the server sent otherwise', () => {
  assert.equal(formatCoords(13.060412, 80.249679, 'FULL'), '13.060412, 80.249679');
  assert.equal(formatCoords(13.0604, 80.2497, 'STANDARD'), '13.0604, 80.2497');
  assert.equal(formatCoords(null, 80, 'FULL'), null);
  assert.equal(isApproximate('FULL'), false);
  assert.equal(isApproximate('STANDARD'), true);
  assert.equal(isApproximate('MINIMAL'), true);
});

test('consent labels: granted, withdrawn, never recorded; routing badge', () => {
  assert.deepEqual(consentStatus({ active: true, revokedAt: null }), { label: 'Granted', tone: 'success' });
  assert.deepEqual(consentStatus({ active: false, revokedAt: '2026-11-01T00:00:00Z' }), { label: 'Withdrawn', tone: 'destructive' });
  assert.deepEqual(consentStatus(null), { label: 'Not recorded', tone: 'warning' });
  assert.equal(routingConsentBadge(true).label, 'Consent given');
  assert.equal(routingConsentBadge(false).tone, 'warning');
  assert.equal(consentPurposeLabel('TRANSPORT_PROFILE'), 'Transport planning');
  assert.equal(consentPurposeLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
});

test('consentRows lists every purpose in order; timeline is newest first', () => {
  const rows = consentRows([{ purpose: 'SOS_LOCATION', active: true, noticeVersion: 'v2', grantedAt: 'x', revokedAt: null, channel: 'WEB' }]);
  assert.deepEqual(rows.map((r) => r.purpose), [...CONSENT_PURPOSES]);
  assert.equal(rows.find((r) => r.purpose === 'SOS_LOCATION')?.state?.noticeVersion, 'v2');
  assert.equal(rows.find((r) => r.purpose === 'TRANSPORT_PROFILE')?.state, null);
  const h = (id: string, at: string, v = 'v1'): ConsentRecordDto => ({ id, purpose: 'TRANSPORT_PROFILE', granted: true, noticeVersion: v, locale: null, channel: 'WEB', evidenceRef: null, note: null, subjectUserId: null, actorUserId: null, occurredAt: at });
  const tl = consentTimeline([h('a', '2026-01-01T00:00:00Z'), h('b', '2026-03-01T00:00:00Z', 'v3'), h('c', '2026-02-01T00:00:00Z')]);
  assert.deepEqual(tl.map((r) => r.id), ['b', 'c', 'a']);
});

test('peopleErrorKind maps the E2 error codes', () => {
  assert.equal(peopleErrorKind('IDENTITY_IN_USE'), 'identity');
  assert.equal(peopleErrorKind('INVALID_STATE'), 'state');
  assert.equal(peopleErrorKind('PASSENGER_DUPLICATE'), 'duplicate');
  assert.equal(peopleErrorKind('IMPORT_FORMAT'), 'format');
  assert.equal(peopleErrorKind('CONSENT_NOTICE_MISSING'), 'notice');
  assert.equal(peopleErrorKind('CONSENT_NOTICE_OUTDATED'), 'notice');
  assert.equal(peopleErrorKind(null), 'other');
});

test('validateEmergencyContacts: blank rows dropped, phones normalised, at most 3', () => {
  const ok = validateEmergencyContacts([{ name: ' Ravi ', phone: '098765 43210', relation: 'Brother' }, { name: '', phone: '' }], 'IN');
  assert.deepEqual(ok, { contacts: [{ name: 'Ravi', phone: '+919876543210', relation: 'Brother' }], errors: [] });
  const bad = validateEmergencyContacts([{ name: '', phone: '12' }], 'IN');
  assert.deepEqual(bad.errors.map((e) => e.field), ['name', 'phone']);
  const many = validateEmergencyContacts(Array.from({ length: 4 }, (_, i) => ({ name: `C${i}`, phone: `987650000${i}` })), 'IN');
  assert.equal(many.errors.length, 1);
});

test('parseLatLng and parseSeats', () => {
  assert.deepEqual(parseLatLng('13.0604123', '80.2496789'), { lat: 13.060412, lng: 80.249679 });
  assert.equal(parseLatLng('0', '0'), null);
  assert.equal(parseLatLng('91', '80'), null);
  assert.equal(parseLatLng('', '80'), null);
  assert.equal(parseLatLng('abc', '80'), null);
  assert.equal(parseSeats('12'), 12);
  assert.equal(parseSeats(' 100 '), 100);
  assert.equal(parseSeats('0'), null);
  assert.equal(parseSeats('101'), null);
  assert.equal(parseSeats('4.5'), null);
});

const notice = (purpose: string, version: string, over: Partial<ConsentNoticeDto> = {}): ConsentNoticeDto => ({
  id: `${purpose}-${version}`,
  purpose,
  version,
  title: 'Transport planning',
  body: 'We use your home location to plan your pickup.',
  locale: 'en',
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  createdByName: 'Admin',
  ...over,
});

test('noticeFor / noticeVersions pick a purpose; grants need a notice in force', () => {
  const dto = {
    current: [
      { purpose: 'TRANSPORT_PROFILE' as const, notice: notice('TRANSPORT_PROFILE', 'v2'), scheduled: notice('TRANSPORT_PROFILE', 'v10') },
      { purpose: 'SOS_LOCATION' as const, notice: null, scheduled: null },
    ],
    history: [notice('TRANSPORT_PROFILE', 'v2'), notice('TRANSPORT_PROFILE', 'v10'), notice('SOS_LOCATION', 'v1'), notice('TRANSPORT_PROFILE', 'v1')],
  };
  assert.equal(noticeFor(dto, 'TRANSPORT_PROFILE').notice?.version, 'v2');
  assert.equal(noticeFor(dto, 'TRANSPORT_PROFILE').scheduled?.version, 'v10');
  assert.deepEqual(noticeFor(dto, 'NOTIFICATIONS_SMS'), { notice: null, scheduled: null });
  assert.deepEqual(noticeFor(undefined, 'SOS_LOCATION'), { notice: null, scheduled: null });
  assert.deepEqual(
    noticeVersions(dto, 'TRANSPORT_PROFILE').map((n) => n.version),
    ['v10', 'v2', 'v1'],
  ); // numeric, not text order
  assert.equal(canGrantWithNotice(noticeFor(dto, 'TRANSPORT_PROFILE').notice), true);
  assert.equal(canGrantWithNotice(noticeFor(dto, 'SOS_LOCATION').notice), false);
});

test('validateNoticeDraft: required, limits, no past date, must differ from the notice in force', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const ok = validateNoticeDraft({ title: '  Transport   planning ', body: 'Text\r\nmore', effectiveFrom: '' }, null, now);
  assert.deepEqual(ok, { errors: [], input: { title: 'Transport planning', body: 'Text\nmore' } });
  assert.deepEqual(
    validateNoticeDraft({ title: '', body: ' ', effectiveFrom: '' }, null, now).errors.map((e) => e.field),
    ['title', 'body'],
  );
  assert.equal(validateNoticeDraft({ title: 'x'.repeat(121), body: 'b', effectiveFrom: '' }, null, now).errors[0].field, 'title');
  assert.equal(validateNoticeDraft({ title: 't', body: 'b', effectiveFrom: '2026-11-01T09:00:00Z' }, null, now).errors[0].message, 'Cannot be in the past');
  const future = validateNoticeDraft({ title: 't', body: 'b', effectiveFrom: '2026-12-01T09:00:00Z' }, null, now);
  assert.equal(future.input?.effectiveFrom, '2026-12-01T09:00:00.000Z');
  const same = validateNoticeDraft({ title: 'Transport planning', body: 'We use your home location to plan your pickup.', effectiveFrom: '' }, notice('TRANSPORT_PROFILE', 'v1'), now);
  assert.equal(same.input, null);
  assert.match(same.errors[0].message, /Nothing changed/);
});

test('geocodeMatchBadge maps Photon confidence; null confidence shows nothing', () => {
  assert.equal(geocodeMatchBadge({ confidence: 0.9 })?.label, 'Exact address');
  assert.equal(geocodeMatchBadge({ confidence: 0.6 })?.label, 'Street');
  assert.equal(geocodeMatchBadge({ confidence: 0.25 })?.tone, 'warning');
  assert.equal(geocodeMatchBadge({ confidence: null }), null);
});

test('history entries: titles per entity / action, readable field rows, hidden values say so', () => {
  const e = (entity: string, action: string, changes: unknown): Pick<AuditLogDto, 'entity' | 'action' | 'changes'> => ({ entity, action, changes });
  assert.equal(historyEntrySummary(e('EmployeeTransportProfile', 'CREATE', { before: {}, after: { employeeCode: 'E1' } })).title, 'Passenger added');
  assert.equal(historyEntrySummary(e('EmployeeTransportProfile', 'UPDATE', { before: { isActive: true }, after: { isActive: false } })).title, 'Passenger archived');
  assert.equal(historyEntrySummary(e('EmployeeTransportProfile', 'UPDATE', { before: { userId: 'u' }, after: { userId: null } })).title, 'App login unlinked');
  assert.equal(historyEntrySummary(e('EmployeeTransportProfile', 'UPDATE', { before: { mobile: 'a' }, after: { mobile: 'b' } })).title, 'Profile changed');
  assert.deepEqual(historyEntrySummary(e('EmployeeTransportConsent', 'CREATE', { before: {}, after: { purpose: 'TRANSPORT_PROFILE', granted: true } })), { title: 'Consent given', detail: 'Transport planning', tone: 'success' });
  assert.equal(historyEntrySummary(e('EmployeeTransportConsent', 'CREATE', { before: {}, after: { purpose: 'SOS_LOCATION', granted: false } })).tone, 'destructive');
  assert.equal(historyEntrySummary(e('User', 'UPDATE', { what: 'passenger-login-disabled', outcome: 'DEACTIVATED' })).title, 'App login disabled');
  assert.equal(historyEntrySummary(e('User', 'UPDATE', { what: 'passenger-login-unlinked' })).title, 'App login unlinked');
  assert.deepEqual(historyEntrySummary(e('EmployeeTransportProfile', 'ACCESS', { what: 'detail', agreementId: 'a' })), { title: 'Details viewed', detail: 'By a transport provider', tone: 'muted' });
  assert.deepEqual(
    historyFieldRows({ before: { homeAddress: 'changed', isActive: true, officePoiId: null }, after: { homeAddress: 'changed', isActive: false, officePoiId: 's1' } }),
    [
      { field: 'homeAddress', label: 'Home address', before: 'Changed (value hidden)', after: 'Changed (value hidden)' },
      { field: 'isActive', label: 'Active', before: 'Yes', after: 'No' },
      { field: 'officePoiId', label: 'Office / site', before: '—', after: 's1' },
    ],
  );
  assert.deepEqual(historyFieldRows({ what: 'detail' }), []);
  assert.deepEqual(historyDetails({ what: 'passenger-login-disabled', outcome: 'DEACTIVATED', passengerId: 'p' }), [{ key: 'outcome', value: 'DEACTIVATED' }]);
  assert.deepEqual(historyDetails({ before: {}, after: {} }), []);
});

test('login removal wording distinguishes disable (link kept) from unlink (link removed)', () => {
  assert.equal(LOGIN_REMOVAL_TEXT.disable.action, 'Disable login');
  assert.match(LOGIN_REMOVAL_TEXT.disable.description, /enable it again/);
  assert.equal(LOGIN_REMOVAL_TEXT.unlink.action, 'Unlink login');
  assert.match(LOGIN_REMOVAL_TEXT.unlink.description, /not deleted/);
});
