import {
  ImportFormatError,
  applyPatch,
  finaliseRow,
  parseCsv,
  parseRowSelection,
  readPassengerCsv,
  refMap,
  validateImportRows,
  type ExistingProfile,
  type ImportLookups,
} from './passenger-import';

const buf = (s: string) => Buffer.from(s, 'utf8');

function lookups(over: Partial<ImportLookups> = {}): ImportLookups {
  return {
    country: 'IN',
    sites: refMap([{ id: '11111111-1111-4111-8111-111111111111', name: 'HQ Guindy' }]),
    stops: refMap([{ id: '22222222-2222-4222-8222-222222222222', name: 'Stop Velachery' }]),
    branches: refMap([{ id: '33333333-3333-4333-8333-333333333333', name: 'Chennai' }]),
    existing: new Map(),
    emailOwners: new Map(),
    mobileOwners: new Map(),
    ...over,
  };
}

const existing = (over: Partial<ExistingProfile> = {}): ExistingProfile => ({
  id: 'p-1',
  employeeCode: 'E1',
  displayName: 'Asha Krishnan',
  mobile: '+919876543210',
  email: 'asha@corp.test',
  homeAddress: '12 Anna Salai',
  homeLat: 13.0604,
  homeLng: 80.2496,
  homeGeocodeSource: 'IMPORT',
  homeGeocodeConfidence: null,
  officePoiId: null,
  defaultStopPoiId: null,
  branchId: null,
  accessibility: {},
  isActive: true,
  ...over,
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and a BOM', () => {
    const t = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3');
    expect(t).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });

  it('detects semicolon-separated files', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,b\n"open,2')).toThrow(ImportFormatError);
  });
});

describe('readPassengerCsv', () => {
  it('maps header aliases and keeps only non-empty cells', () => {
    const r = readPassengerCsv(buf('Emp Code,Full Name,Phone,Latitude,Longitude,Site\nE1,Asha,9876543210,13.06,80.24,HQ Guindy\nE2,Ravi,,,,\n'));
    expect(r.columns).toEqual(expect.arrayContaining(['employee_code', 'name', 'mobile', 'home_lat', 'home_lng', 'office']));
    expect(r.rows[0]).toEqual({ row: 1, cells: { employee_code: 'E1', name: 'Asha', mobile: '9876543210', home_lat: '13.06', home_lng: '80.24', office: 'HQ Guindy' } });
    expect(r.rows[1].cells).toEqual({ employee_code: 'E2', name: 'Ravi' });
  });

  it('needs employee_code and name, refuses Excel workbooks and empty files', () => {
    expect(() => readPassengerCsv(buf('name,mobile\nAsha,1'))).toThrow(/employee_code and name/);
    expect(() => readPassengerCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toThrow(/Excel/);
    expect(() => readPassengerCsv(buf('employee_code,name\n'))).toThrow(/no rows/);
    expect(() => readPassengerCsv(buf(''))).toThrow(/empty/);
  });
});

describe('validateImportRows', () => {
  const rows = (csv: string) => readPassengerCsv(buf(csv)).rows;

  it('normalises a valid row (phone per country, email, coordinates, references by name or id)', () => {
    const [v] = validateImportRows(rows('employee_code,name,mobile,email,home_lat,home_lng,office,default_stop,branch,wheelchair,active\nE1,  Asha   K ,098765 43210,ASHA@Corp.test,13.0604123,80.2496789,hq guindy,22222222-2222-4222-8222-222222222222,Chennai,yes,1'), lookups());
    expect(v.result.errors).toEqual([]);
    expect(v.result.action).toBe('CREATE');
    expect(v.patch).toEqual({
      employeeCode: 'E1',
      displayName: 'Asha K',
      mobile: '+919876543210',
      email: 'asha@corp.test',
      homeLat: 13.060412,
      homeLng: 80.249679,
      homeSource: 'IMPORT',
      homeConfidence: null,
      officePoiId: '11111111-1111-4111-8111-111111111111',
      defaultStopPoiId: '22222222-2222-4222-8222-222222222222',
      branchId: '33333333-3333-4333-8333-333333333333',
      wheelchair: true,
      isActive: true,
    });
  });

  it('reports every row error with its column', () => {
    const [v] = validateImportRows(rows('employee_code,name,mobile,email,home_lat,home_lng,office,branch,active\n,,12,not-an-email,0,0,Nowhere,Mars,maybe'), lookups());
    expect(v.result.action).toBe('ERROR');
    expect(v.patch).toBeNull();
    expect(v.result.errors.map((e) => `${e.column}:${e.code}`).sort()).toEqual(
      ['active:INVALID_VALUE', 'branch:UNKNOWN_BRANCH', 'email:INVALID_EMAIL', 'employee_code:REQUIRED', 'home_lng:INVALID_COORDINATES', 'mobile:INVALID_MOBILE', 'name:REQUIRED', 'office:UNKNOWN_SITE'].sort(),
    );
  });

  it('a lone latitude or an out-of-range point is rejected; US numbers use +1 for US companies', () => {
    const [a, b] = validateImportRows(rows('employee_code,name,home_lat,home_lng\nE1,A,13.0,\nE2,B,91,80'), lookups());
    expect(a.result.errors[0].code).toBe('INVALID_COORDINATES');
    expect(b.result.errors[0].code).toBe('INVALID_COORDINATES');
    const [us] = validateImportRows(rows('employee_code,name,mobile\nU1,Sam,(415) 555-0100'), lookups({ country: 'US' }));
    expect(us.patch?.mobile).toBe('+14155550100');
  });

  it('flags duplicates by employee code, email and mobile in the file (later rows)', () => {
    const v = validateImportRows(
      rows('employee_code,name,email,mobile\nE1,A,a@x.test,9876500001\nE1,A again,,\nE2,B,A@X.test,\nE3,C,,+919876500001\nE4,D,d@x.test,9876500004'),
      lookups(),
    );
    expect(v.map((r) => r.result.action)).toEqual(['CREATE', 'ERROR', 'ERROR', 'ERROR', 'CREATE']);
    expect(v[1].result.errors[0]).toMatchObject({ code: 'DUPLICATE_EMPLOYEE_CODE', message: 'Employee code already on row 1' });
    expect(v[2].result.errors[0].code).toBe('DUPLICATE_EMAIL');
    expect(v[3].result.errors[0].code).toBe('DUPLICATE_MOBILE');
  });

  it('flags a contact owned by another existing employee; the same employee keeps its own contact', () => {
    const lk = lookups({ emailOwners: new Map([['a@x.test', 'E9']]), mobileOwners: new Map([['+919876500001', 'E1']]) });
    const v = validateImportRows(rows('employee_code,name,email,mobile\nE1,A,a@x.test,9876500001'), lk);
    expect(v[0].result.errors.map((e) => e.code)).toEqual(['DUPLICATE_EMAIL']);
  });
});

describe('import diff (idempotency)', () => {
  const rows = (csv: string) => readPassengerCsv(buf(csv)).rows;

  it('UNCHANGED when the file matches the stored profile; empty cells keep stored values', () => {
    const lk = lookups({ existing: new Map([['E1', existing()]]), emailOwners: new Map([['asha@corp.test', 'E1']]) });
    const [v] = validateImportRows(rows('employee_code,name,email,home_address,home_lat,home_lng\nE1,Asha Krishnan,asha@corp.test,12 Anna Salai,13.0604,80.2496'), lk);
    expect(finaliseRow(v)).toMatchObject({ action: 'UNCHANGED', changed: [] });
    const [w] = validateImportRows(rows('employee_code,name,mobile\nE1,Asha Krishnan,'), lk);
    expect(finaliseRow(w).action).toBe('UNCHANGED');
  });

  it('UPDATE lists only the changed fields', () => {
    const lk = lookups({ existing: new Map([['E1', existing()]]) });
    const [v] = validateImportRows(rows('employee_code,name,mobile,accessibility_notes\nE1,Asha Krishnan,9876500002,Needs front seat'), lk);
    const f = finaliseRow(v);
    expect(f.action).toBe('UPDATE');
    expect(f.changed.sort()).toEqual(['accessibility', 'mobile']);
  });

  it('a new address without coordinates clears the stale pin (needs location); the same address keeps it', () => {
    const t = applyPatch(existing(), { employeeCode: 'E1', displayName: 'Asha Krishnan', homeAddress: '99 New Street' });
    expect(t).toMatchObject({ homeAddress: '99 New Street', homeLat: null, homeLng: null, homeGeocodeSource: null });
    const same = applyPatch(existing(), { employeeCode: 'E1', displayName: 'Asha Krishnan', homeAddress: '12 Anna Salai' });
    expect(same).toMatchObject({ homeLat: 13.0604, homeLng: 80.2496 });
  });

  it('warns NO_LOCATION for an active passenger without home point or stop', () => {
    const [v] = validateImportRows(rows('employee_code,name,home_address\nE5,Ravi,7 Lake View'), lookups());
    expect(finaliseRow(v).action).toBe('CREATE');
    expect(v.result.warnings.map((w) => w.code)).toEqual(['NO_LOCATION']);
    const [s] = validateImportRows(rows('employee_code,name,default_stop\nE6,Mala,Stop Velachery'), lookups());
    finaliseRow(s);
    expect(s.result.warnings).toEqual([]);
  });
});

describe('parseRowSelection', () => {
  it('parses lists and ranges, empty = all', () => {
    expect(parseRowSelection('1, 3-5,9')).toEqual(new Set([1, 3, 4, 5, 9]));
    expect(parseRowSelection('')).toBeNull();
    expect(parseRowSelection(undefined)).toBeNull();
    expect(() => parseRowSelection('1;2')).toThrow(ImportFormatError);
    expect(() => parseRowSelection('5-2')).toThrow(ImportFormatError);
  });
});
