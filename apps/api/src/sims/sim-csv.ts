/**
 * Bulk SIM registration from an operator CSV: parsing and row validation (pure, no database). The service then
 * resolves providers / plans and existing ICCIDs / MSISDNs against the database and builds the dry-run report.
 */
import { normalizeIccid, normalizeMsisdn, SIM_OWNERSHIPS, SimOwnership } from '@veetracer/shared';
import { isValidDateOnly, splitCsvLine, StockCsvFormatError } from '../inventory/stock-csv';

export const SIM_IMPORT_MAX_ROWS = 1000;
export const SIM_IMPORT_TEMPLATE_HEADER = 'iccid,msisdn,imsi,provider,plan,renewal_due,ownership,note';

export class SimCsvFormatError extends StockCsvFormatError {}

export interface SimCsvRow {
  line: number;
  iccid: string | null;
  msisdn: string | null;
  imsi: string | null;
  provider: string | null;
  plan: string | null;
  renewalDueAt: string | null;
  ownership: SimOwnership | null;
  note: string | null;
  errors: string[];
}

type Field = 'iccid' | 'msisdn' | 'imsi' | 'provider' | 'plan' | 'renewal' | 'ownership' | 'note';

const HEADER_ALIASES: Record<Field, string[]> = {
  iccid: ['iccid', 'simserial', 'iccidno', 'simid'],
  msisdn: ['msisdn', 'mobile', 'mobileno', 'simnumber', 'number', 'phone'],
  imsi: ['imsi'],
  provider: ['provider', 'operator', 'network', 'carrier'],
  plan: ['plan', 'planname', 'tariff'],
  renewal: ['renewaldue', 'renewaldate', 'renewal', 'expiry', 'expirydate', 'validtill', 'renewaldueat'],
  ownership: ['ownership', 'owner'],
  note: ['note', 'notes', 'remarks'],
};

const text = (v: string | undefined, max: number, label: string, errors: string[]): string | null => {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (t.length > max) errors.push(`${label} is longer than ${max} characters`);
  if (/^[=+@]/.test(t) && label !== 'MSISDN') errors.push(`${label} must not start with "=", "+" or "@"`);
  return t.slice(0, max);
};

/**
 * Parse and validate the file. Throws SimCsvFormatError when the file is unusable (no header, no ICCID column, too many
 * rows); row problems are returned per row. Duplicate ICCIDs / MSISDNs inside the file are errors.
 */
export function parseSimCsv(input: string): SimCsvRow[] {
  const lines = input.replace(/^﻿/, '').split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx < 0) throw new SimCsvFormatError('The file is empty');
  const sep = !lines[firstIdx].includes(',') && lines[firstIdx].includes(';') ? ';' : ',';
  const header = splitCsvLine(lines[firstIdx], sep).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = {} as Record<Field, number>;
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) col[field] = header.findIndex((h) => HEADER_ALIASES[field].includes(h));
  if (col.iccid < 0) throw new SimCsvFormatError(`The first line must be a header with an "iccid" column (template: ${SIM_IMPORT_TEMPLATE_HEADER})`);

  const body = lines.map((l, i) => ({ text: l, line: i + 1 })).slice(firstIdx + 1).filter((l) => l.text.trim());
  if (!body.length) throw new SimCsvFormatError('The file has a header but no rows');
  if (body.length > SIM_IMPORT_MAX_ROWS) throw new SimCsvFormatError(`At most ${SIM_IMPORT_MAX_ROWS} rows per import (file has ${body.length})`);

  const seenIccid = new Map<string, number>();
  const seenMsisdn = new Map<string, number>();
  return body.map(({ text: lineText, line }) => {
    const f = splitCsvLine(lineText, sep);
    const at = (field: Field) => (col[field] >= 0 ? f[col[field]] : undefined);
    const errors: string[] = [];

    const rawIccid = (at('iccid') ?? '').trim();
    const iccid = normalizeIccid(rawIccid);
    if (!rawIccid) errors.push('ICCID is required');
    else if (!iccid) errors.push('ICCID must be 18-22 digits');
    if (iccid) {
      const first = seenIccid.get(iccid);
      if (first) errors.push(`Duplicate ICCID in the file (also on line ${first})`);
      else seenIccid.set(iccid, line);
    }

    const rawMsisdn = (at('msisdn') ?? '').trim();
    const msisdn = rawMsisdn ? normalizeMsisdn(rawMsisdn) : null;
    if (rawMsisdn && !msisdn) errors.push('MSISDN must be 8-15 digits');
    if (msisdn) {
      const first = seenMsisdn.get(msisdn);
      if (first) errors.push(`Duplicate MSISDN in the file (also on line ${first})`);
      else seenMsisdn.set(msisdn, line);
    }

    const imsi = (at('imsi') ?? '').replace(/\s/g, '') || null;
    if (imsi && !/^\d{6,15}$/.test(imsi)) errors.push('IMSI must be 6-15 digits');

    const renewal = (at('renewal') ?? '').trim() || null;
    if (renewal && !isValidDateOnly(renewal)) errors.push('Renewal date must be YYYY-MM-DD');

    const own = (at('ownership') ?? '').trim().toUpperCase() || null;
    if (own && !(SIM_OWNERSHIPS as readonly string[]).includes(own)) errors.push(`Ownership must be one of ${SIM_OWNERSHIPS.join(', ')}`);

    const provider = text(at('provider'), 80, 'Provider', errors);
    return {
      line,
      iccid,
      msisdn,
      imsi,
      provider,
      plan: text(at('plan'), 80, 'Plan', errors),
      renewalDueAt: renewal,
      ownership: (own as SimOwnership | null) ?? null,
      note: text(at('note'), 500, 'Note', errors),
      errors,
    };
  });
}
