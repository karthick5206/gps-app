import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// The G8 build check (plain ESM script at the repo root).
import {
  checkBundleStyleBase,
  findExternalMapHosts,
  styleOrigins,
  styleValueProblem,
  validateStyleEnv,
} from '../../../../../../scripts/check-no-external-maps.mjs';

const SCRIPT = fileURLToPath(new URL('../../../../../../scripts/check-no-external-maps.mjs', import.meta.url));

/** QA-2's three bypasses (v181-qa.md): a style URL without .json, protocol-relative, and userinfo. */
const QA_BYPASS = {
  VITE_MAP_STYLE_STANDARD: 'https://maps.example.net/basemap/liberty',
  VITE_MAP_STYLE_LIGHT: '//tiles.example.net/styles/positron.json',
  VITE_MAP_STYLE_DARK: 'https://app.veetrax.com@evil.example.net/tiles/styles/dark.json',
};
const LOCAL = {
  VITE_MAP_STYLE_STANDARD: 'http://localhost:8080/tiles/styles/liberty.json',
  VITE_MAP_STYLE_LIGHT: 'http://localhost:8080/tiles/styles/positron.json',
  VITE_MAP_STYLE_DARK: 'http://localhost:8080/tiles/styles/dark.json',
};
const UNSET = { VITE_MAP_STYLE_STANDARD: '', VITE_MAP_STYLE_LIGHT: '', VITE_MAP_STYLE_DARK: '' };

/** The minified shape vite emits for map-style.ts, with the shared same-origin fallback. */
function fakeBundle(env: Record<string, string>): string {
  const lit = (v: string) => (v ? `\`${v}\`` : 'void 0');
  return [
    'function Kn(e){let t=e.replace(/\\/+$/,``);return{standard:`${t}/tiles/styles/liberty.json`,light:`${t}/tiles/styles/positron.json`,dark:`${t}/tiles/styles/dark.json`}}',
    `cs=rs({standard:${lit(env.VITE_MAP_STYLE_STANDARD)},light:${lit(env.VITE_MAP_STYLE_LIGHT)},dark:${lit(env.VITE_MAP_STYLE_DARK)}},window.location.origin);`,
  ].join('\n');
}

test('style env: QA-2 bypasses are rejected, same-origin /tiles and our own hosts are accepted', () => {
  assert.equal(validateStyleEnv(QA_BYPASS).length, 3);
  assert.match(styleValueProblem(QA_BYPASS.VITE_MAP_STYLE_STANDARD)!, /maps\.example\.net/);
  assert.match(styleValueProblem(QA_BYPASS.VITE_MAP_STYLE_LIGHT)!, /protocol-relative/);
  assert.match(styleValueProblem(QA_BYPASS.VITE_MAP_STYLE_DARK)!, /userinfo/);
  for (const bad of ['https://user:pw@app.veetrax.com/tiles/styles/a.json', 'ftp://app.veetrax.com/tiles/styles/a.json', '/styles/x.json', 'tiles/styles/x.json', 'https://app.veetrax.com.evil.net/tiles/styles/a.json', 'https://app.veetrax.com\\@evil.net/x']) {
    assert.ok(styleValueProblem(bad), bad);
  }
  assert.deepEqual(validateStyleEnv(LOCAL), []);
  assert.deepEqual(validateStyleEnv(UNSET), []);
  assert.deepEqual(validateStyleEnv({}), []);
  assert.equal(styleValueProblem('/tiles/styles/liberty.json'), null);
  assert.equal(styleValueProblem('https://app.veetrax.com/tiles/styles/liberty.json'), null);
  assert.deepEqual([...styleOrigins(LOCAL)], ['http://localhost:8080']);
});

test('bundle style base: unset → same-origin fallback; set → exactly the build-env value', () => {
  assert.deepEqual(checkBundleStyleBase(fakeBundle(UNSET), UNSET), []);
  assert.deepEqual(checkBundleStyleBase(fakeBundle(LOCAL), LOCAL), []);
  assert.equal(checkBundleStyleBase(fakeBundle(QA_BYPASS), QA_BYPASS).length, 3);
  // A value in the bundle that is not this build's env (e.g. checked without the env it was built with) fails too.
  const other = { ...LOCAL, VITE_MAP_STYLE_DARK: 'https://app.veetrax.com/tiles/styles/dark.json' };
  assert.equal(checkBundleStyleBase(fakeBundle(other), LOCAL).length, 1);
  assert.match(checkBundleStyleBase('no map here', UNSET)[0], /not found/);
});

test('bundle scan: map-context URLs must use the build-time style origin exactly', () => {
  const allowedOrigins = styleOrigins(LOCAL);
  assert.deepEqual(findExternalMapHosts(fakeBundle(LOCAL), { allowedOrigins }), []);
  // Another of our own hosts or another port is not the configured origin.
  assert.ok(findExternalMapHosts('`https://app.veetrax.com/tiles/styles/dark.json`', { allowedOrigins }).length > 0);
  assert.ok(findExternalMapHosts('`http://localhost:9999/tiles/styles/dark.json`', { allowedOrigins }).length > 0);
  assert.ok(findExternalMapHosts('`http://localhost:8080/tiles/styles/dark.json`', { allowedOrigins: new Set() }).length > 0);
  // Non-map links in the bundle stay allowed.
  assert.deepEqual(findExternalMapHosts('`https://app.veetrax.com/api/v1/openapi.json` `http://localhost` `https://github.com/naptha/tesseract.js`', { allowedOrigins: new Set() }), []);
});

test('matcher: QA-2 bypasses in text, anchored exemptions, routing and geocoding hosts', () => {
  for (const bad of [
    ...Object.values(QA_BYPASS).map((v) => `"${v}"`),
    '"//tiles.example.net/{z}/{x}/{y}.png"',
    'https://maps.example.net/s?style=liberty&key=1',
    'https://t.example.net/tiles/{quadkey}.jpeg',
    'https://wms.example.net/wms?SERVICE=WMS&BBOX={bbox-epsg-3857}',
    'https:\\/\\/tiles.example.net\\/{z}\\/{x}\\/{y}.png',
    'https://openmaptiles.org/fonts/{fontstack}/{range}.pbf', // exempt prefix abuse
    'https://www.openstreetmap.org/copyright/{z}/{x}/{y}.png', // exempt prefix abuse
    'https://www.google.com/maps?q=1/vt/lyrs=m&x={x}&y={y}&z={z}', // O9 prefix + tiles
    'https://nominatim.openstreetmap.org/search?q=x',
    'https://photon.komoot.io/api?q=x',
    'https://router.project-osrm.org/route/v1/driving/1,2;3,4',
    'https://graphhopper.com/api/1/route?point=1,2',
    'https://api.openrouteservice.org/v2/directions/driving-car',
    'https://api.mapbox.com/directions/v5/mapbox/driving/1,2;3,4',
    'https://api.mapbox.com/geocoding/v5/mapbox.places/x.json',
    'https://maps.googleapis.com/maps/api/geocode/json?address=x',
    'https://maps.googleapis.com/maps/api/directions/json?origin=a',
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    'https://valhalla1.openstreetmap.de/route',
    'ftp://tiles.example.net/{z}/{x}/{y}.pbf',
  ]) {
    assert.ok(findExternalMapHosts(`const u = ${bad.startsWith('"') ? bad : `"${bad}"`};`).length > 0, bad);
  }
  for (const ok of [
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> <a href="https://openmaptiles.org/">© OpenMapTiles</a>',
    'href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`}',
    'href:`https://www.google.com/maps?q=${e.lat},${e.lng}`,target:`_blank`',
    '"https://www.google.com/maps?q="+e.lat+","+e.lng',
    '`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`',
    '`https://maps.google.com/?q=${lat},${lng}`',
    '// Read the body; //eslint-disable-line',
  ]) {
    assert.deepEqual(findExternalMapHosts(ok), [], ok);
  }
});

/** Runs the real check script on a fake dist (source scan included) with the given build env. */
function runCheck(env: Record<string, string>): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'g8-check-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="/assets/index.js"></script>');
    writeFileSync(join(dir, 'assets', 'index.js'), fakeBundle(env));
    const r = spawnSync(process.execPath, [SCRIPT, dir], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('check script: the three QA-2 bypasses fail the build; unset and localhost pass', () => {
  const bad = runCheck(QA_BYPASS);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /VITE_MAP_STYLE_STANDARD.*maps\.example\.net/);
  assert.match(bad.out, /VITE_MAP_STYLE_LIGHT.*protocol-relative/);
  assert.match(bad.out, /VITE_MAP_STYLE_DARK.*userinfo/);
  for (const [k, v] of Object.entries(QA_BYPASS)) {
    const one = runCheck({ ...UNSET, [k]: v });
    assert.equal(one.status, 1, `${k}: ${one.out}`);
  }
  const unset = runCheck(UNSET);
  assert.equal(unset.status, 0, unset.out);
  assert.match(unset.out, /style base same-origin \/tiles/);
  const local = runCheck(LOCAL);
  assert.equal(local.status, 0, local.out);
  assert.match(local.out, /style base http:\/\/localhost:8080/);
});
