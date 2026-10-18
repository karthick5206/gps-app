/**
 * Veetrax brand assets from one mark (dotted trip line ending in a map pin), in the default Teal & Saffron palette.
 *
 *   npm i --no-save --prefix <tmp> @resvg/resvg-js@2.6.2
 *   RESVG_FROM=<tmp>/package.json node scripts/brand/generate.mjs
 *
 * Writes brand/ (logos, store graphics, email header), apps/mobile/assets/images (app icon, adaptive icon, splash,
 * notification) and apps/web/public (favicons, PWA icons, social image). Fonts: brand/fonts (Manrope, SIL OFL).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { Resvg } = createRequire(process.env.RESVG_FROM ?? import.meta.url)('@resvg/resvg-js');
const FONTS = [join(root, 'brand/fonts/Manrope-700.ttf'), join(root, 'brand/fonts/Manrope-800.ttf')];

/** Teal & Saffron (THEMES[0] in @veetracer/shared). */
const C = { teal: '#0E5E57', tealDeep: '#0B3B36', saffron: '#FFB443', saffronInk: '#E08B00', white: '#FFFFFF', mint: '#CFE3DF' };

// ───────────── mark ─────────────
// 64-unit box. Pin with a real hole (even-odd) so it works on any background; route = round dots + origin dot.
const PIN = 'M32 5C20.4 5 11 14.2 11 25.6 11 40.5 32 59 32 59s21-18.5 21-33.4C53 14.2 43.6 5 32 5z M24 25.6a8 8 0 1 0 16 0a8 8 0 1 0-16 0z';
// Trip dots along the cubic M10 54 C26 54 30 46 42 44, evenly in t (true circles: dashed round caps render oval).
const ROUTE_DOTS = [0.25, 0.5, 0.75, 1].map((t) => {
  const u = 1 - t;
  const p = (a, b, c, d) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return [p(10, 26, 30, 42).toFixed(2), p(54, 54, 46, 44).toFixed(2)];
});
function mark({ x, y, size, pin, route }) {
  const k = size / 64;
  return `<g transform="translate(${x} ${y}) scale(${k})">
    ${ROUTE_DOTS.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="2.4" fill="${route}"/>`).join("")}
    <circle cx="10" cy="54" r="5" fill="${route}"/>
    <path transform="translate(24 0) scale(0.72)" d="${PIN}" fill="${pin}" fill-rule="evenodd"/>
  </g>`;
}
/** Faint street grid + a trip line ending in a pin: the "map" motif for banners. Coordinates in a 1024×500 frame. */
function mapMotif({ w, h, line, route, pin }) {
  return `<svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 1024 500" preserveAspectRatio="xMaxYMid slice">
    <g stroke="${line}" stroke-width="10" opacity="0.13" fill="none"><path d="M0 130H1024M0 340H1024M560 0V500M760 0V500M920 0V500M380 500L1024 30"/></g>
    <path d="M560 440c120 0 120-100 200-100s100-130 160-130" stroke="${route}" stroke-width="14" stroke-linecap="round" stroke-dasharray="1 28" fill="none"/>
    <circle cx="560" cy="440" r="18" fill="${route}"/>
    <path transform="translate(884 80) scale(1.15)" d="${PIN}" fill="${pin}" fill-rule="evenodd"/>
  </svg>`;
}
const word = ({ x, y, size, fill, weight = 800, anchor = 'start' }) =>
  `<text x="${x}" y="${y}" font-family="Manrope" font-weight="${weight}" font-size="${size}" letter-spacing="${-0.03 * size}" fill="${fill}" text-anchor="${anchor}">veetrax</text>`;
const svg = (w, h, body, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;

// ───────────── output ─────────────
const written = [];
function png(path, source, width) {
  const out = join(root, path);
  mkdirSync(dirname(out), { recursive: true });
  const r = new Resvg(source, { fitTo: width ? { mode: 'width', value: width } : { mode: 'original' }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Manrope' } });
  writeFileSync(out, r.render().asPng());
  written.push(path);
}
function file(path, text) {
  const out = join(root, path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  written.push(path);
}

// Square app icon: teal, mark at ~62 % (Play / App Store / iOS: full-bleed, no transparency; stores round the corners).
const appIcon = (s) => svg(s, s, mark({ x: s * 0.17, y: s * 0.18, size: s * 0.64, pin: C.white, route: C.saffron }), C.teal);
// Rounded-square icon for the web (favicon, PWA "any").
const roundIcon = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" rx="${s * 0.22}" fill="${C.teal}"/>${mark({ x: s * 0.15, y: s * 0.16, size: s * 0.68, pin: C.white, route: C.saffron })}</svg>`;

// Mobile (Expo): app.json points at these.
png('apps/mobile/assets/images/icon.png', appIcon(1024));
// Adaptive icon: 108 dp canvas, 66 dp visible circle → keep the mark inside the middle ~46 %.
png('apps/mobile/assets/images/android-icon-foreground.png', svg(1024, 1024, mark({ x: 1024 * 0.27, y: 1024 * 0.28, size: 1024 * 0.46, pin: C.white, route: C.saffron })));
png(
  'apps/mobile/assets/images/android-icon-background.png',
  svg(1024, 1024, `<g stroke="${C.white}" stroke-width="18" opacity="0.07" fill="none"><path d="M0 300H1024M0 720H1024M300 0V1024M720 0V1024"/></g>`, C.teal),
);
png('apps/mobile/assets/images/android-icon-monochrome.png', svg(1024, 1024, mark({ x: 1024 * 0.27, y: 1024 * 0.28, size: 1024 * 0.46, pin: C.white, route: C.white })));
// Splash: mark over the wordmark on teal (expo-splash-screen backgroundColor = C.teal).
png('apps/mobile/assets/images/splash-icon.png', svg(1024, 1024, mark({ x: 312, y: 150, size: 400, pin: C.white, route: C.saffron }) + word({ x: 512, y: 760, size: 190, fill: C.white, anchor: 'middle' })));
png('apps/mobile/assets/images/favicon.png', roundIcon(48));

// Web
file('apps/web/public/favicon.svg', roundIcon(64));
png('apps/web/public/favicon-32.png', roundIcon(32));
png('apps/web/public/apple-touch-icon.png', appIcon(180));
png('apps/web/public/icon-192.png', roundIcon(192));
png('apps/web/public/icon-512.png', roundIcon(512));
png('apps/web/public/icon-maskable-512.png', svg(512, 512, mark({ x: 512 * 0.24, y: 512 * 0.25, size: 512 * 0.52, pin: C.white, route: C.saffron }), C.teal));
file(
  'apps/web/public/manifest.webmanifest',
  `${JSON.stringify(
    {
      name: 'Veetrax',
      short_name: 'Veetrax',
      description: 'Live fleet tracking: alerts, trips, drivers and reports.',
      start_url: '/',
      display: 'standalone',
      background_color: C.teal,
      theme_color: C.teal,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  )}\n`,
);
const banner = (w, h, { title, tagline, sub }) =>
  svg(
    w,
    h,
    mapMotif({ w, h, line: C.white, route: C.saffron, pin: C.white }) +
      mark({ x: w * 0.055, y: h * 0.2, size: h * 0.2, pin: C.white, route: C.saffron }) +
      word({ x: w * 0.055 + h * 0.23, y: h * 0.36, size: h * 0.15, fill: C.white }) +
      `<text x="${w * 0.055}" y="${h * 0.58}" font-family="Manrope" font-weight="800" font-size="${h * 0.085}" fill="${C.white}">${title}</text>` +
      `<text x="${w * 0.055}" y="${h * 0.69}" font-family="Manrope" font-weight="700" font-size="${h * 0.05}" fill="${C.mint}">${tagline}</text>` +
      (sub ? `<text x="${w * 0.055}" y="${h * 0.8}" font-family="Manrope" font-weight="700" font-size="${h * 0.045}" fill="${C.saffron}">${sub}</text>` : ''),
    C.teal,
  );
png('apps/web/public/og-image.png', banner(1200, 630, { title: 'Live fleet tracking', tagline: 'Alerts, trips, drivers and reports for every vehicle.', sub: 'Web · Android · iOS' }));

// Stores
png('brand/store/play-icon-512.png', appIcon(512));
png('brand/store/play-feature-graphic-1024x500.png', banner(1024, 500, { title: 'Live fleet tracking', tagline: 'Alerts, trips, drivers and reports for every vehicle.', sub: 'Hindi · Tamil · English' }));
png('brand/store/appstore-icon-1024.png', appIcon(1024));

// Logos: horizontal lockup on white and on teal, vertical lockup, mark alone (SVG + PNG).
const lockup = (bg, pin, route, ink) =>
  svg(920, 300, mark({ x: 40, y: 50, size: 200, pin, route }) + word({ x: 270, y: 205, size: 150, fill: ink }), bg);
png('brand/logo/veetrax-logo.png', lockup(null, C.teal, C.saffronInk, C.tealDeep));
png('brand/logo/veetrax-logo-white.png', lockup(null, C.white, C.saffron, C.white));
png('brand/logo/veetrax-logo-on-teal.png', lockup(C.teal, C.white, C.saffron, C.white));
png('brand/logo/veetrax-logo-vertical.png', svg(800, 800, mark({ x: 220, y: 90, size: 360, pin: C.teal, route: C.saffronInk }) + word({ x: 400, y: 640, size: 150, fill: C.tealDeep, anchor: 'middle' })));
file('brand/logo/veetrax-mark.svg', svg(64, 64, mark({ x: 0, y: 0, size: 64, pin: C.teal, route: C.saffronInk })));
file('brand/logo/veetrax-mark-white.svg', svg(64, 64, mark({ x: 0, y: 0, size: 64, pin: C.white, route: C.saffron })));
png('brand/logo/veetrax-mark-512.png', svg(512, 512, mark({ x: 0, y: 0, size: 512, pin: C.teal, route: C.saffronInk })));

// E-mail header (600 px wide templates; @2x for sharp screens).
const emailHeader = (w, h) =>
  svg(w, h, mapMotif({ w, h, line: C.white, route: C.saffron, pin: C.white }) + mark({ x: w * 0.04, y: h * 0.22, size: h * 0.56, pin: C.white, route: C.saffron }) + word({ x: w * 0.04 + h * 0.66, y: h * 0.64, size: h * 0.36, fill: C.white }), C.teal);
png('brand/email/email-header-600x120.png', emailHeader(600, 120));
png('brand/email/email-header-1200x240.png', emailHeader(1200, 240));

console.log(written.join('\n'));
