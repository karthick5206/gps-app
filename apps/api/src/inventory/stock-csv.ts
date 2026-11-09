/**
 * Bulk stock import: CSV parsing and row validation (pure, no database). The service then resolves models, existing
 * devices and duplicates against the database and builds the dry-run report.
 */
import { DEVICE_CONDITIONS, DeviceCondition } from '@veetracer/shared';
/** Same rule as Device create (devices.dto UNIQUE_ID_PATTERN); repeated here because DTO modules are not loadable in jest. */
export const UNIQUE_ID_PATTERN = /^[0-9A-Za-z_-]{4,32}$/;

export const IMPORT_MAX_ROWS = 500;

export const IMPORT_TEMPLATE_HEADER = 'imei,model,serial,unit_cost,warranty_until,condition,sim,operator,note';

export class StockCsvFormatError extends Error {}

export interface StockCsvRow {
  /** 1-based line in the file (header = 1). */
  line: number;
  uniqueId: string | null;
  /** Device model: its id, or "Brand Model" as shown in Device Models. */
  model: string | null;
  serialNumber: string | null;
  unitCostPaise: number | null;
  warrantyUntil: string | null;
  condition: DeviceCondition | null;
  simNumber: string | null;
  simOperator: string | null;
  note: string | null;
  errors: string[];
}

type Field = 'imei' | 'model' | 'serial' | 'cost' | 'warranty' | 'condition' | 'sim' | 'operator' | 'note';

const HEADER_ALIASES: Record<Field, string[]> = {
  imei: ['imei', 'uniqueid', 'imeiuniqueid', 'deviceid', 'imeiid'],
  model: ['model', 'devicemodel', 'modelid'],
  serial: ['serial', 'serialnumber', 'serialno'],
  cost: ['unitcost', 'cost', 'unitcostinr', 'price'],
  warranty: ['warrantyuntil', 'warranty', 'warrantyend'],
  condition: ['condition'],
  sim: ['sim', 'simnumber', 'msisdn'],
  operator: ['operator', 'simoperator'],
  note: ['note', 'notes', 'remarks'],
};

/** Split one CSV line (comma or semicolon), honouring double quotes ("" = literal quote). */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Rupees text ("1499", "1,499.50", "₹1499") → paise; null when blank; NaN when invalid. */
export function parseRupeesToPaise(text: string | undefined): number | null {
  const t = (text ?? '').replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** YYYY-MM-DD that is a real calendar date. */
export function isValidDateOnly(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

const clean = (v: string | undefined, max: number, label: string, errors: string[]): string | null => {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (t.length > max) {
    errors.push(`${label} is longer than ${max} characters`);
    return t.slice(0, max);
  }
  // A leading formula character is not allowed in identifiers / notes we export again later.
  if (/^[=+@]/.test(t)) errors.push(`${label} must not start with "=", "+" or "@"`);
  return t;
};

/**
 * Parse and validate the file. Throws StockCsvFormatError when the file itself is unusable (no header, no IMEI
 * column, too many rows); row problems are returned per row. Duplicate IMEIs / serials inside the file are errors.
 */
export function parseStockCsv(text: string): StockCsvRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx < 0) throw new StockCsvFormatError('The file is empty');
  const sep = !lines[firstIdx].includes(',') && lines[firstIdx].includes(';') ? ';' : ',';
  const header = splitCsvLine(lines[firstIdx], sep).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = {} as Record<Field, number>;
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) col[field] = header.findIndex((h) => HEADER_ALIASES[field].includes(h));
  if (col.imei < 0) throw new StockCsvFormatError(`The first line must be a header with an "imei" column (template: ${IMPORT_TEMPLATE_HEADER})`);

  const body = lines.map((l, i) => ({ text: l, line: i + 1 })).slice(firstIdx + 1).filter((l) => l.text.trim());
  if (!body.length) throw new StockCsvFormatError('The file has a header but no rows');
  if (body.length > IMPORT_MAX_ROWS) throw new StockCsvFormatError(`At most ${IMPORT_MAX_ROWS} rows per import (file has ${body.length})`);

  const seenImei = new Map<string, number>();
  const seenSerial = new Map<string, number>();
  return body.map(({ text: lineText, line }) => {
    const f = splitCsvLine(lineText, sep);
    const at = (field: Field) => (col[field] >= 0 ? f[col[field]] : undefined);
    const errors: string[] = [];

    const imei = (at('imei') ?? '').replace(/\s/g, '');
    const uniqueId: string | null = imei || null;
    if (!imei) errors.push('IMEI is required');
    else if (!UNIQUE_ID_PATTERN.test(imei)) errors.push('IMEI must be 4-32 letters, digits, "-" or "_"');
    if (uniqueId) {
      const first = seenImei.get(uniqueId.toLowerCase());
      if (first) errors.push(`Duplicate IMEI in the file (also on line ${first})`);
      else seenImei.set(uniqueId.toLowerCase(), line);
    }

    const serialNumber = clean(at('serial'), 60, 'Serial number', errors);
    if (serialNumber) {
      const first = seenSerial.get(serialNumber.toLowerCase());
      if (first) errors.push(`Duplicate serial number in the file (also on line ${first})`);
      else seenSerial.set(serialNumber.toLowerCase(), line);
    }

    const cost = parseRupeesToPaise(at('cost'));
    if (cost !== null && (Number.isNaN(cost) || cost > 100_000_000)) errors.push('Unit cost must be an amount in rupees (e.g. 1499 or 1499.50)');

    const warranty = (at('warranty') ?? '').trim() || null;
    if (warranty && !isValidDateOnly(warranty)) errors.push('Warranty date must be YYYY-MM-DD');

    const condText = (at('condition') ?? '').trim().toUpperCase() || null;
    if (condText && !(DEVICE_CONDITIONS as readonly string[]).includes(condText)) errors.push(`Condition must be one of ${DEVICE_CONDITIONS.join(', ')}`);

    return {
      line,
      uniqueId,
      model: clean(at('model'), 120, 'Model', errors),
      serialNumber,
      unitCostPaise: cost === null || Number.isNaN(cost) ? null : cost,
      warrantyUntil: warranty,
      condition: (condText as DeviceCondition | null) ?? null,
      simNumber: clean(at('sim'), 20, 'SIM number', errors),
      simOperator: clean(at('operator'), 40, 'Operator', errors),
      note: clean(at('note'), 500, 'Note', errors),
      errors,
    };
  });
}
