import { parseSimCsv, SIM_IMPORT_MAX_ROWS, SimCsvFormatError } from './sim-csv';

describe('parseSimCsv', () => {
  it('reads the template columns and header aliases (BOM, CRLF, semicolons)', () => {
    const rows = parseSimCsv('﻿ICCID;Mobile No;IMSI;Operator;Plan;Expiry Date;Owner;Remarks\r\n8991 1012 3456 7890 123F;+91 98450 12345;404451234567890;Airtel;M2M 1GB;2027-01-31;platform;first\r\n');
    expect(rows).toEqual([
      {
        line: 2,
        iccid: '8991101234567890123',
        msisdn: '919845012345',
        imsi: '404451234567890',
        provider: 'Airtel',
        plan: 'M2M 1GB',
        renewalDueAt: '2027-01-31',
        ownership: 'PLATFORM',
        note: 'first',
        errors: [],
      },
    ]);
  });

  it('reports row errors and in-file duplicates', () => {
    const rows = parseSimCsv(
      [
        'iccid,msisdn,imsi,renewal_due,ownership,note',
        '8991101234567890123,9845012345,,,,',
        '8991101234567890123,9845012345,12,2027-02-30,LEASED,=cmd()',
        ',,,,,',
        '123,abc,,,,',
      ].join('\n'),
    );
    expect(rows[0].errors).toEqual([]);
    expect(rows[1].errors).toEqual([
      'Duplicate ICCID in the file (also on line 2)',
      'Duplicate MSISDN in the file (also on line 2)',
      'IMSI must be 6-15 digits',
      'Renewal date must be YYYY-MM-DD',
      'Ownership must be one of PLATFORM, PARTNER, CUSTOMER',
      'Note must not start with "=", "+" or "@"',
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[2].errors).toContain('ICCID is required');
    expect(rows[3].errors).toEqual(['ICCID must be 18-22 digits', 'MSISDN must be 8-15 digits']);
  });

  it('refuses unusable files', () => {
    expect(() => parseSimCsv('')).toThrow(SimCsvFormatError);
    expect(() => parseSimCsv('msisdn\n9845012345')).toThrow(/iccid/);
    expect(() => parseSimCsv('iccid\n')).toThrow(/no rows/);
    const big = ['iccid', ...Array.from({ length: SIM_IMPORT_MAX_ROWS + 1 }, (_, i) => String(8991101234567000000n + BigInt(i)))].join('\n');
    expect(() => parseSimCsv(big)).toThrow(/At most/);
  });
});
