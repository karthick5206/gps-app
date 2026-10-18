/**
 * Merges translation results into the shared dictionaries.
 *
 *   node scripts/i18n-merge.mjs out-1.json out-2.json …
 *
 * Each input maps English → { hi, ta }. Existing entries are kept unless the input has a value for them.
 * Entries whose {{placeholders}} differ from the English key are rejected (they would break interpolation).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = { hi: { name: 'HI', title: 'Hindi', script: 'हिन्दी' }, ta: { name: 'TA', title: 'Tamil', script: 'தமிழ்' } };

const unescape = (s) => s.replace(/\\(.)/g, '$1');
function load(lang) {
  const src = readFileSync(join(root, `packages/shared/src/i18n/${lang}.ts`), 'utf8');
  const out = {};
  for (const m of src.matchAll(/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),?\s*$/gm)) {
    out[unescape(m[1].slice(1, -1))] = unescape(m[2].slice(1, -1));
  }
  return out;
}
const placeholders = (s) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

const dicts = Object.fromEntries(Object.keys(LANGS).map((l) => [l, load(l)]));
const rejected = [];
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [en, tr] of Object.entries(data)) {
    for (const lang of Object.keys(LANGS)) {
      const v = tr?.[lang];
      if (typeof v !== 'string' || !v.trim()) continue;
      if (placeholders(v) !== placeholders(en)) {
        rejected.push(`${lang}: ${en} → ${v}`);
        continue;
      }
      dicts[lang][en] = v;
    }
  }
}
for (const [lang, meta] of Object.entries(LANGS)) {
  const entries = Object.entries(dicts[lang]).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([k, v]) => `  ${q(k)}: ${q(v)},`).join('\n');
  writeFileSync(
    join(root, `packages/shared/src/i18n/${lang}.ts`),
    `/** ${meta.title} UI strings: English source text → ${meta.script}. Missing keys fall back to English.\n * Generated / merged by scripts/i18n-merge.mjs — edit freely; keep {{placeholders}} unchanged. */\nexport const ${meta.name}: Record<string, string> = {\n${body}\n};\n`,
  );
  console.log(`${lang}: ${entries.length} entries`);
}
if (rejected.length) console.log(`rejected (placeholder mismatch):\n${rejected.join('\n')}`);
