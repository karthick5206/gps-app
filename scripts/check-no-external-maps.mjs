#!/usr/bin/env node
// G8 build check: the web app must load every map style, tile, glyph and sprite from our own server. Fails (exit 1)
// when the built web bundle or the web / shared source names an outside map host.
//
//   node scripts/check-no-external-maps.mjs                 # apps/web/dist + apps/web/src + packages/shared/src
//   node scripts/check-no-external-maps.mjs apps/web/dist-ci  # another build output (CI)
//
// Runs after `vite build` in `npm run build -w @veetracer/web` (so also in release.sh) and in CI.
// Allowed on purpose (EXEMPT): map-data attribution links and the owner-approved Google Maps hand-off links (O9),
// which open in the user's own browser / app on a click and are not background map loads.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Outside map style / tile / glyph / imagery hosts. Case-insensitive. */
export const RULES = [
  ['OpenFreeMap', /openfreemap/i],
  ['OpenStreetMap tile servers', /\btiles?\.openstreetmap\.(org|de|fr)|\btile\.osm\.org|\btiles?\.openstreetmap\.fr/i],
  ['Mapbox', /\bmapbox:\/\/|\b(api|tiles|[a-d]\.tiles)\.mapbox\.com/i],
  ['MapTiler', /\bmaptiler\.com|\bmaptiler\.cloud/i],
  ['Google Maps tiles / APIs', /\bmaps\.googleapis\.com|\bmaps\.gstatic\.com|\bmt[0-3]?\.google\.com|\bkhms?[0-3]?\.google\.com|\bgoogle\.com\/maps\/(vt|embed|api)|\btile\.googleapis\.com/i],
  ['Esri / ArcGIS basemaps', /\barcgisonline\.com|\b(i?basemaps(-api)?|static-map-tiles-api)\.arcgis\.com/i],
  ['CARTO basemaps', /\bbasemaps\.cartocdn\.com|\bcartocdn\.com/i],
  ['Stadia / Stamen', /\bstadiamaps\.com|\bstamen-tiles/i],
  ['Thunderforest', /\bthunderforest\.com/i],
  ['MapLibre demo tiles', /\bdemotiles\.maplibre\.org/i],
  ['Protomaps API', /\bapi\.protomaps\.com/i],
  ['OpenTopoMap', /\bopentopomap\.org/i],
  ['Wikimedia maps', /\bmaps\.wikimedia\.org/i],
  ['HERE', /\b(api|vector|maps)\.hereapi\.com|\.maps\.ls\.hereapi\.com/i],
  ['TomTom', /\bapi\.tomtom\.com/i],
  ['Bing Maps', /\bvirtualearth\.net|\btiles\.virtualearth/i],
];

/**
 * Removed before matching. Attribution links (the map data's licence pages) and the O9 hand-offs:
 * web AttendancePage.tsx `https://www.google.com/maps?q=` (l.106, l.159); mobile `sos/[id].tsx` / `attendance-day.tsx`
 * and the notification template `map_link` use the same link forms and are listed here so the rule stays explicit
 * should this check ever scan them.
 */
export const EXEMPT = [
  /https?:\/\/(www\.)?openstreetmap\.org\/copyright\/?/gi,
  /https?:\/\/(www\.)?openmaptiles\.org\/?/gi,
  /https?:\/\/(www\.)?google\.com\/maps\?q=/gi, // O9: web AttendancePage, mobile attendance-day
  /https?:\/\/maps\.google\.com\/\?q=/gi, // O9: notification template map_link (apps/api templates)
  /https?:\/\/(www\.)?google\.com\/maps\/(search|dir)\/\?api=1/gi, // O9: mobile Google web fallback
  /google\.navigation:/gi, // O9: mobile Android intent
  /maps:\/\/\?/gi, // O9: mobile iOS Apple Maps
];

/** Matches of outside map hosts in `text`: rule name and a short excerpt around each hit. */
export function findExternalMapHosts(text) {
  let t = text;
  for (const re of EXEMPT) t = t.replace(re, (m) => ' '.repeat(m.length));
  const hits = [];
  for (const [name, re] of RULES) {
    const g = new RegExp(re.source, 'gi');
    for (let m = g.exec(t); m; m = g.exec(t)) {
      const at = m.index;
      hits.push({ rule: name, index: at, excerpt: text.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.json', '.map', '.svg', '.txt', '.webmanifest', '.xml']);

function walk(dir, out, skipTests) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, skipTests);
    else if (TEXT_EXT.has(extname(name)) && !(skipTests && /\.(test|spec)\.[cm]?[jt]sx?$/.test(name))) out.push(p);
  }
  return out;
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dists = (argv.length ? argv : ['apps/web/dist']).map((d) => resolve(root, d));
  const sources = ['apps/web/src', 'packages/shared/src', 'apps/web/index.html'].map((d) => resolve(root, d));
  const files = [];
  for (const d of dists) {
    // A missing build must fail, not pass silently.
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      console.error(`check-no-external-maps: build output not found: ${relative(root, d)} (run vite build first)`);
      process.exit(1);
    }
    walk(d, files, false);
  }
  for (const s of sources) {
    if (!existsSync(s)) continue;
    if (statSync(s).isDirectory()) walk(s, files, true);
    else files.push(s);
  }
  let bad = 0;
  for (const f of files) {
    for (const h of findExternalMapHosts(readFileSync(f, 'utf8'))) {
      bad++;
      console.error(`  ${relative(root, f)}: ${h.rule}: …${h.excerpt}…`);
    }
  }
  if (bad) {
    console.error(`check-no-external-maps: FAIL, ${bad} outside map host reference(s). Maps must load from our own /tiles (G8).`);
    process.exit(1);
  }
  console.log(`check-no-external-maps: OK, ${files.length} files scanned (${dists.map((d) => relative(root, d)).join(', ')} + web/shared source), no outside map hosts.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
