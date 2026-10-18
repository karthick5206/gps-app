import { StreamableFile } from '@nestjs/common';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join('; ') : value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFile<T>(name: string, rows: T[], columns: CsvColumn<T>[]): StreamableFile {
  const date = new Date().toISOString().slice(0, 10);
  return new StreamableFile(Buffer.from(toCsv(rows, columns), 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${name}-${date}.csv"`,
  });
}
