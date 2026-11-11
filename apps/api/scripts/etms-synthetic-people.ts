/**
 * WP 2.5: write clearly synthetic ETMS test data (no database access, nothing is imported automatically).
 *   npx tsx scripts/etms-synthetic-people.ts --count 500 [--seed 7] [--cities CHE,BLR,AUS,CMH] [--out ./synthetic-etms]
 * Files:
 *   passengers.csv  passenger import file (Transport → Passengers → Import), PASSENGER_IMPORT_COLUMNS
 *   offices.csv     the office Places to create first (category OFFICE, exact names: the import matches by name)
 *   shifts.csv      shift windows per passenger and the shift list, for E3 schedule tests
 * Names start with "Synthetic", emails end in @synthetic.example, India phones are +91 00000…, US phones +1 555-01…
 * See src/etms/people/synthetic-people.ts.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { SYNTHETIC_CITIES, SYNTHETIC_SHIFTS, generateSyntheticPassengers, toImportCsv } from '../src/etms/people/synthetic-people';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const count = Number(arg('count', '200'));
if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('--count must be 1..10000 (the import limit)');
const cities = arg('cities', '').split(',').filter(Boolean);
const out = resolve(arg('out', './synthetic-etms'));
const rows = generateSyntheticPassengers({ count, seed: Number(arg('seed', '20261111')), cities });

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'passengers.csv'), toImportCsv(rows));
const used = SYNTHETIC_CITIES.filter((c) => !cities.length || cities.includes(c.key));
writeFileSync(join(out, 'offices.csv'), ['name,category,lat,lng', ...used.flatMap((c) => c.offices.map((o) => `${o.name},OFFICE,${o.lat},${o.lng}`))].join('\n') + '\n');
writeFileSync(
  join(out, 'shifts.csv'),
  ['shift_code,name,start,end,days', ...SYNTHETIC_SHIFTS.map((s) => `${s.code},${s.name},${s.start},${s.end},${s.days}`), '', 'employee_code,shift_code', ...rows.map((r) => `${r.employee_code},${r.shift}`)].join('\n') + '\n',
);
console.log(`Wrote ${rows.length} synthetic passengers to ${out} (passengers.csv, offices.csv, shifts.csv)`);
