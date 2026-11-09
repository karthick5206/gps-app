import { isMismatch, licenceStatusOf } from './inventory.mapper';
import { IMPORT_MAX_ROWS, IMPORT_TEMPLATE_HEADER, isValidDateOnly, parseRupeesToPaise, parseStockCsv, splitCsvLine, StockCsvFormatError } from './stock-csv';

describe('stock CSV parsing', () => {
  it('splits quoted cells and both separators', () => {
    expect(splitCsvLine('a,"b,c","d ""q"""', ',')).toEqual(['a', 'b,c', 'd "q"']);
    expect(splitCsvLine('a; b ;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('parses rupees into paise and rejects junk', () => {
    expect(parseRupeesToPaise('1499')).toBe(149900);
    expect(parseRupeesToPaise('1,499.5')).toBe(149950);
    expect(parseRupeesToPaise('₹ 12.05')).toBe(1205);
    expect(parseRupeesToPaise('')).toBeNull();
    expect(parseRupeesToPaise(undefined)).toBeNull();
    expect(parseRupeesToPaise('-5')).toBeNaN();
    expect(parseRupeesToPaise('1.234')).toBeNaN();
    expect(parseRupeesToPaise('abc')).toBeNaN();
  });

  it('validates calendar dates', () => {
    expect(isValidDateOnly('2027-02-28')).toBe(true);
    expect(isValidDateOnly('2027-02-30')).toBe(false);
    expect(isValidDateOnly('28/02/2027')).toBe(false);
  });

  it('reads columns by header in any order, with BOM and CRLF', () => {
    const rows = parseStockCsv(`﻿Serial No,IMEI,Model,Unit Cost,Warranty Until,Condition,SIM,Operator,Note\r\nSN-1,356307042441013,Concox GT06N,"1,499.00",2027-11-30,new,9876543210,Airtel,"first, batch"\r\n`);
    expect(rows).toEqual([
      {
        line: 2,
        uniqueId: '356307042441013',
        model: 'Concox GT06N',
        serialNumber: 'SN-1',
        unitCostPaise: 149900,
        warrantyUntil: '2027-11-30',
        condition: 'NEW',
        simNumber: '9876543210',
        simOperator: 'Airtel',
        note: 'first, batch',
        errors: [],
      },
    ]);
  });

  it('accepts the template header and semicolons', () => {
    const rows = parseStockCsv(`${IMPORT_TEMPLATE_HEADER.replace(/,/g, ';')}\n111122223333;;;;;;;;`);
    expect(rows[0]).toMatchObject({ uniqueId: '111122223333', model: null, errors: [] });
  });

  it('reports row errors without throwing', () => {
    const rows = parseStockCsv(
      [
        'imei,serial,unit_cost,warranty_until,condition,note',
        ',S1,10,,,',
        'bad imei!,S2,,,,',
        '123456789012,S3,ten,2027-13-01,broken,=cmd()',
        '123456789012,S3,,,,',
      ].join('\n'),
    );
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5]);
    expect(rows[0].errors).toContain('IMEI is required');
    expect(rows[1].errors[0]).toMatch(/IMEI must be/);
    expect(rows[2].errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Unit cost/), expect.stringMatching(/Warranty date/), expect.stringMatching(/Condition must be/), expect.stringMatching(/Note must not start/)]),
    );
    expect(rows[3].errors).toEqual(expect.arrayContaining([expect.stringMatching(/Duplicate IMEI .*line 4/), expect.stringMatching(/Duplicate serial .*line 4/)]));
  });

  it('rejects unusable files', () => {
    expect(() => parseStockCsv('')).toThrow(StockCsvFormatError);
    expect(() => parseStockCsv('serial,model\nS1,X')).toThrow(/imei/);
    expect(() => parseStockCsv('imei\n')).toThrow(/no rows/);
    const big = ['imei', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `IMEI${100000 + i}`)].join('\n');
    expect(() => parseStockCsv(big)).toThrow(/At most/);
  });

  it('skips blank lines but keeps real line numbers', () => {
    const rows = parseStockCsv('imei\n\n111122223333\n\n444455556666\n');
    expect(rows.map((r) => [r.line, r.uniqueId])).toEqual([
      [3, '111122223333'],
      [5, '444455556666'],
    ]);
  });
});

describe('stock row derivations', () => {
  it('flags stored statuses that contradict the assignment', () => {
    expect(isMismatch('ACTIVE', 'IN_STOCK')).toBe(true);
    expect(isMismatch('ASSIGNED', 'ACTIVE')).toBe(true);
    expect(isMismatch('ACTIVE', 'ACTIVE')).toBe(false);
    expect(isMismatch('IN_STOCK', 'ASSIGNED')).toBe(true);
    expect(isMismatch('RESERVED', 'IN_STOCK')).toBe(false);
    expect(isMismatch('IN_STOCK', 'RESERVED')).toBe(false);
    expect(isMismatch('FAULTY', 'ACTIVE')).toBe(false);
    expect(isMismatch('RETIRED', 'IN_STOCK')).toBe(false);
  });

  it('shows the licence read-only', () => {
    const now = new Date('2026-11-09T00:00:00Z');
    expect(licenceStatusOf(null, null, now).status).toBe('NOT_IN_ACCOUNT');
    expect(licenceStatusOf('c1', null, now).status).toBe('NO_SEAT');
    expect(licenceStatusOf('c1', { type: 'GPS_DEVICE', expiresAt: new Date('2027-01-01T00:00:00Z') }, now)).toEqual({ status: 'ACTIVE', type: 'GPS_DEVICE', expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(licenceStatusOf('c1', { type: 'GPS_DEVICE', expiresAt: new Date('2026-01-01T00:00:00Z') }, now).status).toBe('EXPIRED');
  });
});
