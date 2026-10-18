/**
 * Collects the English UI strings that need translations (keys = English text) and reports which are missing
 * from the Hindi / Tamil dictionaries in packages/shared/src/i18n.
 *
 *   node scripts/i18n-extract.mjs            → prints counts, writes scripts/i18n-missing.json
 *
 * Sources: literal t('…') / i18n.t('…') calls in apps/web/src and apps/mobile/src, plus label-like properties
 * (label, header, description, title, hint, placeholder, unit, category) in those apps and in the shared catalogues
 * (alert types, statuses, menus, reports) that the apps translate at render time with t(value).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = ['apps/web/src', 'apps/mobile/src', 'packages/shared/src'].map((p) => join(root, p));
const SKIP = /node_modules|\.test\.|\.spec\.|[\\/]i18n[\\/](hi|ta)\.ts$|vehicle-icon-images/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|\`((?:[^\`\\$]|\\.)*)\``;
const T_CALL = new RegExp(String.raw`\b(?:i18n\.)?(?:t|tr)\(\s*(?:${STR})`, 'g');
const PROP = new RegExp(String.raw`\b(label|header|description|title|hint|placeholder|unit|category|message)\s*:\s*(?:${STR})`, 'g');
const STATUS_META_LABEL = /STATUS_META[\s\S]*?=\s*\{([\s\S]*?)\n\};/;

const unescape = (s) => s.replace(/\\(.)/g, '$1');
const keys = new Set();
const add = (s) => {
  if (!s) return;
  const v = unescape(s).trim();
  if (!v || !/[A-Za-z]/.test(v)) return;
  if (/^[a-z0-9_.-]+$/.test(v) && !v.includes(' ') && v === v.toLowerCase() && v.length > 1 && !/^(km|min|s|h)$/.test(v)) return; // ids / keys
  if (/^(#|\/|https?:|[A-Z0-9_]+$)/.test(v)) return; // colours, paths, urls, ENUM_VALUES
  keys.add(v);
};

for (const file of SRC.flatMap((d) => walk(d))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(T_CALL)) add(m[1] ?? m[2] ?? m[3]);
  // Label-like properties are translated at render time (t(def.label)); shared catalogues and app-level config.
  for (const m of text.matchAll(PROP)) add(m[2] ?? m[3] ?? m[4]);
  // JSX string props that shared components translate (title="…", description="…", placeholder="…").
  for (const m of text.matchAll(/\s(?:title|description|label|placeholder|hint|header|aria-label|emptyText|confirmLabel|submitLabel|entity|allLabel|searchPlaceholder)="([^"{}]+)"/g)) add(m[1]);
  // Label maps such as GROUP_LABELS / MODE_LABEL / SEVERITY_LABEL = { key: 'Text', … }.
  for (const m of text.matchAll(/const\s+\w*LABELS?\w*[^=\n]*=\s*\{([\s\S]*?)\};/g)) {
    for (const v of m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) add(v[1]);
  }
}

// Enum values shown through humanize(): VEHICLE_TYPES etc. → "School bus".
const humanize = (v) => v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const shared = readFileSync(join(root, 'packages/shared/src/tracking.ts'), 'utf8');
for (const list of ['OBJECT_TYPES', 'VEHICLE_TYPES']) {
  const m = new RegExp(String.raw`${list}\s*=\s*\[([^\]]+)\]`).exec(shared);
  for (const v of m?.[1].match(/'([A-Z_]+)'/g) ?? []) add(humanize(v.slice(1, -1)));
}
void STATUS_META_LABEL;
// Shown via t(value) from places the scanner cannot see (record values, stored reasons).
for (const v of ['Info', 'Warning', 'Critical', 'New', 'Acknowledged', 'Resolved', 'Queued', 'Sent', 'Failed', 'Expired', 'Push needs a real phone', 'Push not set up for this build', 'Notifications are turned off for VeeTracer', 'Not registered yet', 'On', 'Off', 'Card', 'Manual']) add(v);

const dict = (lang) => {
  const src = readFileSync(join(root, `packages/shared/src/i18n/${lang}.ts`), 'utf8');
  const have = new Set();
  for (const m of src.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:/gm)) have.add(unescape(m[1] ?? m[2]));
  return have;
};
const all = [...keys].sort((a, b) => a.localeCompare(b));
const missing = Object.fromEntries(['hi', 'ta'].map((l) => [l, all.filter((k) => !dict(l).has(k))]));
writeFileSync(join(root, 'scripts/i18n-missing.json'), JSON.stringify({ total: all.length, missing }, null, 2));
console.log(`keys: ${all.length} · missing hi: ${missing.hi.length} · missing ta: ${missing.ta.length}`);
