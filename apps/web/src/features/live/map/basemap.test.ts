import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { basemapStyle, satelliteStyle, selfHostedSite, selfHostedStyles } from '@veetracer/shared';
import { resolveStyleUrls } from './style-urls.ts';
// The G8 build check's matcher (plain ESM script at the repo root).
import { findExternalMapHosts } from '../../../../../../scripts/check-no-external-maps.mjs';

const SITE = 'https://app.veetrax.com';
const SAT = { tiles: ['https://imagery.example/{z}/{y}/{x}'], attribution: 'Imagery', maxZoom: 19 };
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('selfHostedStyles: styles, fonts and India tiles under <base>/tiles', () => {
  assert.deepEqual(selfHostedStyles(`${SITE}/`), {
    standard: `${SITE}/tiles/styles/liberty.json`,
    light: `${SITE}/tiles/styles/positron.json`,
    dark: `${SITE}/tiles/styles/dark.json`,
    overlay: { glyphs: `${SITE}/tiles/fonts/{fontstack}/{range}.pbf`, tiles: `${SITE}/tiles/india/{z}/{x}/{y}` },
  });
  assert.equal(selfHostedStyles('').standard, '/tiles/styles/liberty.json');
});

test('selfHostedSite recognises only <site>/tiles/styles/<name> URLs', () => {
  assert.equal(selfHostedSite(`${SITE}/tiles/styles/liberty.json`), SITE);
  assert.equal(selfHostedSite('http://127.0.0.1:8099/tiles/styles/dark.json'), 'http://127.0.0.1:8099');
  assert.equal(selfHostedSite('https://maps.example.com/styles/liberty'), null);
});

test('resolveStyleUrls: configured VITE_MAP_STYLE_* win, unset ones fall back to the same origin, never outside', () => {
  const set = { standard: `${SITE}/tiles/styles/liberty.json`, light: `${SITE}/tiles/styles/positron.json`, dark: `${SITE}/tiles/styles/dark.json` };
  assert.deepEqual(resolveStyleUrls(set, 'https://other.example'), set);
  const unset = resolveStyleUrls({ standard: '', light: undefined, dark: '  ' }, 'http://127.0.0.1:5174');
  assert.deepEqual(unset, {
    standard: 'http://127.0.0.1:5174/tiles/styles/liberty.json',
    light: 'http://127.0.0.1:5174/tiles/styles/positron.json',
    dark: 'http://127.0.0.1:5174/tiles/styles/dark.json',
  });
  assert.deepEqual(findExternalMapHosts(JSON.stringify(unset)), []);
});

test('basemapStyle picks the configured URL per type and theme', () => {
  const urls = selfHostedStyles(SITE);
  assert.equal(basemapStyle('standard', 'light', null, urls), urls.standard);
  assert.equal(basemapStyle('light', 'light', null, urls), urls.light);
  assert.equal(basemapStyle('light', 'dark', null, urls), urls.dark);
  assert.equal(basemapStyle('satellite', 'light', null, urls), urls.standard); // no imagery configured
});

test('satellite overlay uses the injected / self-hosted base, never an outside host', () => {
  const urls = { standard: `${SITE}/tiles/styles/liberty.json`, light: 'x', dark: 'y' };
  const s = basemapStyle('satellite', 'dark', SAT, urls) as { glyphs: string; sources: Record<string, { tiles?: string[] }> };
  assert.equal(s.glyphs, `${SITE}/tiles/fonts/{fontstack}/{range}.pbf`);
  assert.deepEqual(s.sources.omt.tiles, [`${SITE}/tiles/india/{z}/{x}/{y}`]);
  assert.deepEqual(s.sources.imagery.tiles, SAT.tiles);

  const injected = satelliteStyle(SAT, { glyphs: 'http://127.0.0.1:8099/tiles/fonts/{fontstack}/{range}.pbf', tiles: 'http://127.0.0.1:8099/tiles/india/{z}/{x}/{y}' });
  assert.equal(injected.glyphs, 'http://127.0.0.1:8099/tiles/fonts/{fontstack}/{range}.pbf');

  // A style URL that is not self-hosted gives no overlay source: imagery only, nothing else fetched.
  const bare = basemapStyle('satellite', 'light', SAT, { standard: 'https://maps.example.com/style.json', light: 'x', dark: 'y' }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bare.sources as object), ['imagery']);
  assert.equal(bare.glyphs, undefined);
});

test('the public share page uses the configured style (G8) and no hard-coded basemap', () => {
  const page = read('../../live-share/PublicSharePage.tsx');
  assert.match(page, /style: shareStyleUrl\(\)/);
  assert.doesNotMatch(page, /OPENFREEMAP|https?:\/\/[^'"`]*\/styles\//);
  assert.deepEqual(findExternalMapHosts(page), []);
  assert.match(read('./map-style.ts'), /export function shareStyleUrl\(\): string \{\s+return STYLE_URLS\.standard;/);
});

test('build-check matcher: flags outside map hosts, allows attribution and the O9 Google Maps hand-offs', () => {
  const ofm = ['https://tiles.open', 'freemap.org/styles/liberty'].join('');
  for (const bad of [ofm, 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://api.mapbox.com/styles/v1', 'https://api.maptiler.com/maps/streets/style.json?key=k', 'https://maps.googleapis.com/maps/api/js', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery', 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/1/2/3', 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json']) {
    assert.ok(findExternalMapHosts(`const u = "${bad}";`).length > 0, bad);
  }
  for (const ok of [
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> <a href="https://openmaptiles.org/">© OpenMapTiles</a>',
    'href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`}', // web AttendancePage (O9)
    '`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`', // mobile sos (O9)
    '`google.navigation:q=${lat},${lng}` `maps://?daddr=${lat},${lng}`', // mobile sos (O9)
    '`https://maps.google.com/?q=${lat},${lng}`', // template map_link (O9)
    'https://app.veetrax.com/tiles/styles/liberty.json',
  ]) {
    assert.deepEqual(findExternalMapHosts(ok), [], ok);
  }
});

test('build-check matcher: India and other commercial map hosts, Google embeds, and unknown hosts serving map files', () => {
  for (const bad of [
    'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json', // Ola Maps
    'https://apis.mappls.com/advancedmaps/api/k/map_sdk?layer=vector', // Mappls (MapmyIndia)
    'https://apis.mapmyindia.com/advancedmaps/v1/k/still_image', // MapmyIndia
    'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf', // Protomaps public assets
    'https://build.protomaps.com/20251101.pmtiles',
    'https://tiles.versatiles.org/assets/styles/colorful/style.json', // VersaTiles
    'https://maps.geoapify.com/v1/styles/osm-bright/style.json?apiKey=k', // Geoapify
    'https://tiles.stadiamaps.com/styles/alidade_smooth.json', // Stadia
    'https://tile.thunderforest.com/transport/{z}/{x}/{y}.png', // Thunderforest
    'https://vector.hereapi.com/v2/vectortiles/base/mc/{z}/{x}/{y}/omv', // HERE
    'https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png', // TomTom
    'https://mapbox.com/', // bare Mapbox host
    'src={`https://www.google.com/maps?q=${lat},${lng}&output=embed`}', // Google iframe embed behind the O9 prefix
    'https://www.google.com/maps/embed/v1/place?key=k&q=Chennai',
    'https://tiles.example.net/data/{z}/{x}/{y}.pbf', // unknown host: tile template
    'https://cdn.example.org/glyphs/{fontstack}/{range}.pbf', // unknown host: glyphs
    'https://maps.example.in/styles/basic/style.json', // unknown host: style
    'https://maps.example.in/sprites/basic/sprite@2x.png', // unknown host: sprite
  ]) {
    assert.ok(findExternalMapHosts(`const u = "${bad}";`).length > 0, bad);
  }
  // Our own sites, same-origin paths, loopback and non-map outside links stay allowed.
  for (const ok of [
    'https://app.veetrax.com/tiles/india/{z}/{x}/{y}',
    'https://app.veetrax.com/tiles/fonts/{fontstack}/{range}.pbf',
    'https://us.veetrax.com/tiles/styles/dark.json?v=2',
    '`${b}/tiles/india/{z}/{x}/{y}` `${b}/tiles/fonts/{fontstack}/{range}.pbf`',
    'http://localhost:8099/tiles/styles/liberty.json http://127.0.0.1:3000/india/{z}/{x}/{y}',
    'https://checkout.razorpay.com/v1/checkout.js https://wa.me/?text=hi https://play.google.com/store/apps/details?id=x',
    'href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`}', // O9 link without embed
    'There is no road here.', // the word "here" is not the HERE host
  ]) {
    assert.deepEqual(findExternalMapHosts(ok), [], ok);
  }
});

test('selfHostedSite tolerates a query string or fragment on the style URL', () => {
  assert.equal(selfHostedSite(`${SITE}/tiles/styles/liberty.json?v=2`), SITE);
  assert.equal(selfHostedSite(`${SITE}/tiles/styles/liberty.json#x`), SITE);
  assert.equal(selfHostedSite('https://maps.example.com/styles/liberty.json?v=2'), null);
  const s = basemapStyle('satellite', 'light', SAT, { standard: `${SITE}/tiles/styles/liberty.json?v=2`, light: 'x', dark: 'y' }) as { glyphs: string };
  assert.equal(s.glyphs, `${SITE}/tiles/fonts/{fontstack}/{range}.pbf`);
});
