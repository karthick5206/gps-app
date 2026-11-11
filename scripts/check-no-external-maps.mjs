#!/usr/bin/env node
// G8 build check: the web app must load every map style, tile, glyph and sprite from our own server. Fails (exit 1)
// when the built web bundle or the web / shared source names an outside map (or routing / geocoding) host, or when
// the map style base in the bundle is anything other than the same-origin /tiles/... styles or exactly the
// VITE_MAP_STYLE_* values set for the build (which must themselves be same-origin /tiles/... paths or URLs on one
// of our own hosts, see ALLOWED_MAP_HOSTS).
//
//   node scripts/check-no-external-maps.mjs                 # apps/web/dist + apps/web/src + packages/shared/src
//   node scripts/check-no-external-maps.mjs apps/web/dist-ci  # another build output (CI)
//   VEETRAX_WEB_OUTDIR=dist.next node scripts/check-no-external-maps.mjs   # apps/web/dist.next (release.sh)
//
// Runs after `vite build` in `npm run build -w @veetracer/web` (so also in release.sh) and in CI. The build env is
// read the way `vite build` (mode production) reads it: process.env first, then apps/web/.env.production.local,
// .env.production, .env.local, .env. An empty value counts as unset (the app then uses /tiles on its own origin).
//
// Three layers:
//   1. the VITE_MAP_STYLE_* values themselves (validateStyleEnv): same-origin `/tiles/...`, or http(s) on our own
//      host; never protocol-relative `//host`, userinfo (`https://app.veetrax.com@evil...`), or another host;
//   2. the style configuration inlined in the bundle (checkBundleStyleBase): each value is unset (same-origin
//      /tiles fallback, which must be present) or exactly the build-env value;
//   3. a text scan (findExternalMapHosts): named outside hosts (RULES), and any absolute or protocol-relative URL in a
//      map context (tile template, style, glyph, sprite, basemap path) whose origin is not allowed. In the bundle the
//      only allowed origins are those of the VITE_MAP_STYLE_* values; in source, ALLOWED_MAP_HOSTS.
// Allowed on purpose (EXEMPT, anchored to the exact link form): map-data attribution links and the owner-approved
// Google Maps hand-off links (O9), which open in the user's own browser / app on a click and are not map loads.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Outside map style / tile / glyph / imagery / routing / geocoding hosts. Case-insensitive. */
export const RULES = [
  ['OpenFreeMap', /openfreemap/i],
  ['OpenStreetMap tile servers', /\btiles?\.openstreetmap\.(org|de|fr)|\btile\.osm\.org|\btiles?\.openstreetmap\.fr/i],
  ['Mapbox (tiles, styles, directions, geocoding)', /\bmapbox:\/\/|\bmapbox\.com/i],
  ['MapTiler', /\bmaptiler\.com|\bmaptiler\.cloud/i],
  ['Google Maps tiles / APIs', /\bmaps\.googleapis\.com|\bmaps\.gstatic\.com|\bmt[0-3]?\.google\.com|\bkhms?[0-3]?\.google\.com|\bgoogle\.com\/maps\/(vt|embed|api)|\btile\.googleapis\.com/i],
  ['Google geocoding / directions / routes', /\b(routes|geocoding|places|roads|addressvalidation)\.googleapis\.com|\/maps\/api\/(geocode|directions|distancematrix|place)\b/i],
  ['Esri / ArcGIS basemaps', /\barcgisonline\.com|\b(i?basemaps(-api)?|static-map-tiles-api)\.arcgis\.com/i],
  ['CARTO basemaps', /\bbasemaps\.cartocdn\.com|\bcartocdn\.com/i],
  ['Stadia / Stamen', /\bstadiamaps\.com|\bstamen-tiles/i],
  ['Thunderforest', /\bthunderforest\.com/i],
  ['MapLibre demo tiles', /\bdemotiles\.maplibre\.org/i],
  ['Protomaps (API, public assets, builds)', /\b(api|build)\.protomaps\.com|\bprotomaps\.github\.io/i],
  ['OpenTopoMap', /\bopentopomap\.org/i],
  ['Wikimedia maps', /\bmaps\.wikimedia\.org/i],
  ['HERE', /\bhereapi\.com|\bmaps\.api\.here\.com|\bhere\.com\/v\d/i],
  ['TomTom', /\btomtom\.com/i],
  ['Bing Maps', /\bvirtualearth\.net|\btiles\.virtualearth/i],
  ['Ola Maps', /\bolamaps\.io/i],
  ['Mappls / MapmyIndia', /\bmappls\.com|\bmapmyindia\.(com|in|co\.in)/i],
  ['VersaTiles', /\bversatiles\.org/i],
  ['Geoapify', /\bgeoapify\.com/i],
  ['Google Maps embed', /\boutput=embed\b|\bgoogle\.[a-z.]+\/maps\/embed/i],
  // Routing and geocoding services (the app has its own GraphHopper / Photon behind the API; the browser never
  // calls one directly).
  ['Nominatim (geocoding)', /\bnominatim\.openstreetmap\.(org|de)|\bnominatim\.osm\.org/i],
  ['Photon / Komoot (geocoding)', /\bphoton\.komoot\.(io|de)/i],
  ['OSRM demo router', /\brouter\.project-osrm\.org|\bproject-osrm\.org/i],
  ['GraphHopper cloud', /\bgraphhopper\.com/i],
  ['openrouteservice', /\bopenrouteservice\.org/i],
  ['Valhalla (FOSSGIS)', /\bvalhalla\d*\.openstreetmap\.de/i],
  ['LocationIQ', /\blocationiq\.(com|org)/i],
];

/** Our own sites, the only absolute hosts a map style / tile / glyph / sprite URL may name (else same-origin). */
export const ALLOWED_MAP_HOSTS = [/^([a-z0-9-]+\.)*veetrax\.com$/i, /^localhost$/i, /^127(\.\d+){3}$/, /^\[::1\]$/];

/** The three style settings, their keys in the inlined config, and the same-origin fallback file. */
export const STYLE_KEYS = [
  ['VITE_MAP_STYLE_STANDARD', 'standard', 'liberty.json'],
  ['VITE_MAP_STYLE_LIGHT', 'light', 'positron.json'],
  ['VITE_MAP_STYLE_DARK', 'dark', 'dark.json'],
];

/**
 * Path / query parts that put an absolute URL in a map context: tile templates (XYZ, quadkey, WMS bbox), glyph /
 * style / sprite / vector-tile files, tile, style and basemap folders, a `style=` query.
 */
const MAP_RESOURCE = /\{[zxy]\}|%7B[zxy]%7D|\{quadkey\}|\{bbox-epsg-\d+\}|\{fontstack\}|%7Bfontstack%7D|\.pbf\b|\.mvt\b|\.pmtiles\b|\/style\.json\b|\/styles?\/|\/tiles?\/|\/basemaps?\b|\/glyphs?\/|\/sprites?\b|sprite|tilejson|[?&]style=/i;

/** End of a link: quote, backtick, whitespace, tag or bracket close, or end of text. */
const END = String.raw`(?=["'\x60\s<>)\]]|$)`;
/** Template-literal / concatenation placeholders for coordinates in an O9 link (`${lat},${lng}`, `"+e.lat+"`). */
const COORDS = String.raw`(?:\$\{[^{}\s]{1,60}\}|[-0-9.,+]|%2C)*`;

/**
 * Removed before matching, each anchored to the full link so a longer URL behind the same prefix is NOT exempt.
 * Attribution links (the map data's licence pages) and the O9 hand-offs: web AttendancePage.tsx
 * `https://www.google.com/maps?q=${lat},${lng}` (l.106, l.159); mobile `sos/[id].tsx` / `attendance-day.tsx` and the
 * notification template `map_link` use the same link forms and are listed here so the rule stays explicit should
 * this check ever scan them.
 */
export const EXEMPT = [
  new RegExp(String.raw`https?:\/\/(www\.)?openstreetmap\.org\/copyright\/?` + END, 'gi'),
  new RegExp(String.raw`https?:\/\/(www\.)?openmaptiles\.org\/?` + END, 'gi'),
  new RegExp(String.raw`https?:\/\/(www\.)?google\.com\/maps\?q=` + COORDS + END, 'gi'), // O9: web AttendancePage, mobile attendance-day
  new RegExp(String.raw`https?:\/\/maps\.google\.com\/\?q=` + COORDS + END, 'gi'), // O9: notification template map_link
  new RegExp(String.raw`https?:\/\/(www\.)?google\.com\/maps\/(search|dir)\/\?api=1&(query|destination)=` + COORDS + END, 'gi'), // O9: mobile Google web fallback
  new RegExp(String.raw`google\.navigation:q=` + COORDS + END, 'gi'), // O9: mobile Android intent
  new RegExp(String.raw`maps:\/\/\?daddr=` + COORDS + END, 'gi'), // O9: mobile iOS Apple Maps
];

/**
 * Absolute (`http(s)://`) and protocol-relative (`//host`) URLs, with optional userinfo (skipped: the host is what
 * follows the `@`). Groups: 1 scheme, 2 userinfo, 3 host, 4 port, 5 path/query.
 */
const URL_RE = /(?:\b(https?|wss?|ftp):|(?<![\w:/\\.$}-]))\/\/(?:([^@/\s"'`<>\\]*)@)?(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d+))?(\/[^\s"'`<>()\\]*|\?[^\s"'`<>()\\]*)?/gi;

/**
 * Matches of outside map hosts in `text`: rule name and a short excerpt around each hit.
 * `allowedOrigins` (bundle mode): the exact origins a map-context URL may have (the VITE_MAP_STYLE_* origins);
 * without it (source mode) a map-context URL may name any ALLOWED_MAP_HOSTS host.
 */
export function findExternalMapHosts(text, { allowedOrigins } = {}) {
  // `\/`-escaped slashes (JSON, some minifiers) are matched like plain ones.
  const src = text.replace(/\\\//g, '/');
  let t = src;
  for (const re of EXEMPT) t = t.replace(re, (m) => ' '.repeat(m.length));
  const hits = [];
  const excerpt = (at, len) => src.slice(Math.max(0, at - 40), at + len + 40).replace(/\s+/g, ' ');
  for (const [name, re] of RULES) {
    const g = new RegExp(re.source, 'gi');
    for (let m = g.exec(t); m; m = g.exec(t)) hits.push({ rule: name, index: m.index, excerpt: excerpt(m.index, m[0].length) });
  }
  // Second layer, for hosts the list above does not know: any absolute or protocol-relative URL in a map context
  // whose origin is not allowed. Userinfo is always a hit in a map context (`https://app.veetrax.com@evil...`).
  const url = new RegExp(URL_RE.source, 'gi');
  for (let m = url.exec(t); m; m = url.exec(t)) {
    const [whole, scheme, userinfo, rawHost, port, path] = m;
    const host = rawHost.toLowerCase();
    if (!scheme && !(host.includes('.') || host.startsWith('[') || host === 'localhost')) continue; // `// comment`
    if (!path || !MAP_RESOURCE.test(path)) continue;
    let allowed;
    if (userinfo !== undefined || !scheme || !/^https?$/i.test(scheme)) allowed = false;
    else if (allowedOrigins) allowed = allowedOrigins.has(originOf(scheme, host, port));
    else allowed = ALLOWED_MAP_HOSTS.some((re) => re.test(host));
    if (allowed) continue;
    if (hits.some((h) => h.index >= m.index && h.index < m.index + whole.length)) continue; // already named above
    const why = userinfo !== undefined ? 'userinfo in a map URL' : !scheme ? 'protocol-relative map URL' : 'map resource on an outside host';
    hits.push({ rule: `${why} (${host})`, index: m.index, excerpt: excerpt(m.index, whole.length) });
  }
  return hits;
}

function originOf(scheme, host, port) {
  const s = scheme.toLowerCase();
  const p = port && !((s === 'http' && port === '80') || (s === 'https' && port === '443')) ? `:${port}` : '';
  return `${s}://${host.toLowerCase()}${p}`;
}

/**
 * Problem with one VITE_MAP_STYLE_* value, or null when it is fine. Unset / empty is fine (same-origin fallback).
 * Allowed: a same-origin path under /tiles/, or an http(s) URL without userinfo on an ALLOWED_MAP_HOSTS host.
 */
export function styleValueProblem(value) {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/[\s\\@]/.test(v)) return 'contains whitespace, a backslash or "@" (userinfo is not allowed)';
  if (v.startsWith('//')) return 'is protocol-relative (//host/...); use a same-origin /tiles/... path or a full URL on our own host';
  if (v.startsWith('/')) return v.startsWith('/tiles/') ? null : 'is a same-origin path outside /tiles/';
  let u;
  try {
    u = new URL(v);
  } catch {
    return 'is neither a same-origin /tiles/... path nor an absolute URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `uses ${u.protocol} (http or https only)`;
  if (u.username || u.password) return 'carries userinfo';
  if (!ALLOWED_MAP_HOSTS.some((re) => re.test(u.hostname))) return `names ${u.hostname}, which is not one of our own hosts (G8)`;
  return null;
}

/** Problems of the VITE_MAP_STYLE_* values in `env` (an object of strings). */
export function validateStyleEnv(env) {
  const problems = [];
  for (const [key] of STYLE_KEYS) {
    const p = styleValueProblem(env[key]);
    if (p) problems.push(`${key}=${JSON.stringify(env[key])} ${p}`);
  }
  return problems;
}

/** Origins of the absolute VITE_MAP_STYLE_* values (only valid ones). */
export function styleOrigins(env) {
  const out = new Set();
  for (const [key] of STYLE_KEYS) {
    const v = (env[key] ?? '').trim();
    if (!v || styleValueProblem(v) || v.startsWith('/')) continue;
    out.add(new URL(v).origin);
  }
  return out;
}

/** Minimal dotenv reader (KEY=VALUE, optional `export`, optional quotes); enough for the VITE_MAP_STYLE_* keys. */
function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(['"`])(.*)\1$/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** The VITE_MAP_STYLE_* values `vite build` (mode production) sees: process.env wins over the apps/web .env files. */
export function readStyleEnv(webDir, processEnv = process.env, mode = 'production') {
  const merged = {};
  for (const f of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const p = join(webDir, f);
    if (existsSync(p)) Object.assign(merged, parseDotenv(readFileSync(p, 'utf8')));
  }
  const out = {};
  for (const [key] of STYLE_KEYS) out[key] = processEnv[key] !== undefined ? processEnv[key] : merged[key];
  return out;
}

const LIT = String.raw`(void 0|undefined|null|""|''|\x60\x60|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60[^\x60$\\]*\x60)`;
/** The inlined `resolveStyleUrls({ standard, light, dark }, window.location.origin)` argument (map-style.ts). */
const STYLE_CONFIG_RE = new RegExp(
  String.raw`\{\s*["']?standard["']?\s*:\s*${LIT}\s*,\s*["']?light["']?\s*:\s*${LIT}\s*,\s*["']?dark["']?\s*:\s*${LIT}\s*\}\s*,\s*(?:window\.|self\.|globalThis\.)?location\.origin`,
  'g',
);

function literalValue(lit) {
  if (/^(void 0|undefined|null)$/.test(lit)) return '';
  const body = lit.slice(1, -1);
  if (lit[0] === '"') return JSON.parse(lit);
  return body.replace(/\\(.)/g, '$1');
}

/**
 * Positive check of the bundle's map style base. `bundleText` is the concatenated JS of the build. Each inlined style
 * value must be unset (and the same-origin `/tiles/styles/<file>` fallback must be in the bundle) or exactly the
 * build-env value, which must itself pass styleValueProblem. Returns problems (empty = OK).
 */
export function checkBundleStyleBase(bundleText, env) {
  const problems = [];
  const configs = [...bundleText.matchAll(new RegExp(STYLE_CONFIG_RE.source, 'g'))];
  if (!configs.length) {
    return ['the map style configuration (resolveStyleUrls({standard, light, dark}, window.location.origin)) was not found in the bundle; cannot verify the style base'];
  }
  for (const m of configs) {
    STYLE_KEYS.forEach(([key, name, file], i) => {
      const inBundle = literalValue(m[i + 1]).trim();
      const fromEnv = (env[key] ?? '').trim();
      if (!inBundle) {
        if (!bundleText.includes(`/tiles/styles/${file}`)) problems.push(`${name}: unset, but the same-origin fallback /tiles/styles/${file} is missing from the bundle`);
        return;
      }
      const p = styleValueProblem(inBundle);
      if (p) problems.push(`${name}: the bundle's style URL ${JSON.stringify(inBundle)} ${p}`);
      else if (inBundle !== fromEnv) problems.push(`${name}: the bundle's style URL ${JSON.stringify(inBundle)} is not the ${key} of this build (${JSON.stringify(fromEnv)})`);
    });
  }
  return problems;
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
  // release.sh builds into apps/web/<VEETRAX_WEB_OUTDIR> (dist.next) before swapping it in; vite.config.ts reads it too.
  const outDir = process.env.VEETRAX_WEB_OUTDIR?.trim() || 'dist';
  const dists = (argv.length ? argv : [`apps/web/${outDir}`]).map((d) => resolve(root, d));
  const sources = ['apps/web/src', 'packages/shared/src', 'apps/web/index.html'].map((d) => resolve(root, d));
  let bad = 0;
  const fail = (msg) => {
    bad++;
    console.error(`  ${msg}`);
  };

  // Layer 1: the build env.
  const env = readStyleEnv(resolve(root, 'apps/web'));
  for (const p of validateStyleEnv(env)) fail(`build env: ${p}`);
  const allowedOrigins = styleOrigins(env);

  const distFiles = [];
  for (const d of dists) {
    // A missing build must fail, not pass silently.
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      console.error(`check-no-external-maps: build output not found: ${relative(root, d)} (run vite build first)`);
      process.exit(1);
    }
    const files = walk(d, [], false);
    distFiles.push(...files);
    // Layer 2: the inlined style configuration of this build.
    const js = files.filter((f) => /\.[cm]?js$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const p of checkBundleStyleBase(js, env)) fail(`${relative(root, d)}: style base: ${p}`);
  }
  const sourceFiles = [];
  for (const s of sources) {
    if (!existsSync(s)) continue;
    if (statSync(s).isDirectory()) walk(s, sourceFiles, true);
    else sourceFiles.push(s);
  }
  // Layer 3: text scan. The bundle may only name the build's own style origins; source may name ALLOWED_MAP_HOSTS.
  for (const [files, opts] of [[distFiles, { allowedOrigins }], [sourceFiles, {}]]) {
    for (const f of files) {
      for (const h of findExternalMapHosts(readFileSync(f, 'utf8'), opts)) fail(`${relative(root, f)}: ${h.rule}: …${h.excerpt}…`);
    }
  }
  if (bad) {
    console.error(`check-no-external-maps: FAIL, ${bad} problem(s). Maps must load from our own /tiles (G8).`);
    process.exit(1);
  }
  const base = allowedOrigins.size ? [...allowedOrigins].join(', ') : 'same-origin /tiles';
  console.log(`check-no-external-maps: OK, ${distFiles.length + sourceFiles.length} files scanned (${dists.map((d) => relative(root, d)).join(', ')} + web/shared source), style base ${base}, no outside map hosts.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
