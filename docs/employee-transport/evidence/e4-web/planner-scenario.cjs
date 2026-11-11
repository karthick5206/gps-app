// E4-G planner scenario against the Vite dev server with the planner's synthetic API (vt.plannerMock) and route-mocked
// auth / shifts / dispatch board. Synthetic data only. usage: node e4g-shots.cjs <outdir> <baseUrl>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const OUT = process.argv[2];
const BASE = process.argv[3] || 'http://localhost:5181';
fs.mkdirSync(OUT, { recursive: true });

const ALL = ['view', 'create', 'edit', 'delete', 'export', 'command'];
const me = {
  user: { id: 'u1', name: 'Synthetic Planner', email: 'planner@example.test', mobile: null, isSuperAdmin: false, preferences: { theme: 'light', language: 'en', textSize: 'md', mapIconSize: 'md' } },
  company: { id: 'c1', name: 'Synthetic Co', accountType: 'BUSINESS', status: 'ACTIVE', timezone: 'Asia/Kolkata', thresholds: { idleMinutes: 5, offlineMinutes: 30 }, features: ['etms'] },
  permissions: { etms_planning: ['view', 'create', 'edit', 'delete', 'command'], etms_dispatch: ['view', 'edit', 'command'], etms_dashboard: ['view'] },
  dataScope: 'COMPANY',
  partner: null,
};
const shifts = { items: [
  { id: 'sh-m', name: 'Morning', site: { id: 'poi-site-1', name: 'Synthetic Tech Park', lat: 12.9, lng: 80.2 }, startMin: 540, endMin: 1080, overnight: false, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', isActive: true, scheduleCount: 1, createdAt: '', updatedAt: '' },
  { id: 'sh-e', name: 'Evening', site: { id: 'poi-site-1', name: 'Synthetic Tech Park', lat: 12.9, lng: 80.2 }, startMin: 840, endMin: 1380, overnight: false, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', isActive: true, scheduleCount: 1, createdAt: '', updatedAt: '' },
], total: 2, page: 1, pageSize: 200 };
const board = { serviceDate: '2026-11-12', direction: 'IN', timeZone: 'Asia/Kolkata', queue: [], trips: [], drafts: [], counts: { bookings: 0, queued: 0, assigned: 0, trips: 0, seats: 0, occupied: 0 }, routingAvailable: true,
  vehicles: [
    { objectId: 'veh-1', name: 'Van 01', plateNumber: 'TN00AA0001', seats: 4, busy: [], lastFix: null },
    { objectId: 'veh-2', name: 'Van 02', plateNumber: 'TN00AA0002', seats: 4, busy: [], lastFix: null },
    { objectId: 'veh-3', name: 'Car 03', plateNumber: 'TN00AA0003', seats: 3, busy: [], lastFix: null },
    { objectId: 'veh-4', name: 'Car 04', plateNumber: null, seats: null, busy: [], lastFix: null },
  ] };

async function routes(page) {
  await page.route('**/api/**', (r) => {
    const u = new URL(r.request().url());
    const p = u.pathname.replace(/^\/api/, '');
    const json = (b, s = 200) => r.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/auth/refresh') return json({ accessToken: 'synthetic', refreshToken: 'synthetic-r', expiresIn: 3600 });
    if (p === '/auth/me') return json(me);
    if (p === '/transport/shifts') return json(shifts);
    if (p === '/transport/dispatch/board') return json(board);
    if (p === '/licences/banner') return json({ exempt: true, expiringSoon: 0, inGrace: 0, lockedVehicles: [], canManage: false });
    if (r.request().method() === 'GET') return json([]);
    return json({});
  });
  await page.route('**/socket.io/**', (r) => r.abort());
}

const report = [];
async function shot(page, name) {
  await page.waitForTimeout(700);
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  report.push({ name, sideways: o.sw > o.cw, ...o });
}

async function pick(page, trigger, labels) {
  { const el = page.locator(trigger); const b = await el.boundingBox(); await el.click({ position: { x: b.width - 14, y: b.height / 2 } }); }
  for (const l of labels) { try { await page.getByRole('option', { name: new RegExp(l) }).first().click({ timeout: 8000 }); } catch (e) { await page.screenshot({ path: OUT + '/fail-pick.png' }); throw e; } }
  await page.keyboard.press('Escape');
}

async function optimise(page, vehicles, weights) {
  await page.getByRole('tab', { name: /Optimise/ }).click();
  await page.locator('#opt-day').fill('2026-11-12');
  await pick(page, '#opt-shifts', ['Morning']);
  await pick(page, '#opt-vehicles', vehicles);
  const keys = ['vehicles', 'distance', 'driveTime', 'maxRide', 'unassigned'];
  for (let i = 0; i < keys.length; i++) await page.locator(`#opt-w-${keys[i]}`).fill(String(weights[i]));
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  for (const w of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, isMobile: w < 500, hasTouch: w < 500 });
    await ctx.addInitScript(() => {
      localStorage.setItem('vt.refreshToken', 'synthetic-r');
      localStorage.setItem('vt.language', 'en');
      if (!sessionStorage.getItem('e4g.mode')) sessionStorage.setItem('e4g.mode', '1');
      localStorage.setItem('vt.plannerMock', sessionStorage.getItem('e4g.mode'));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 1500)); });

    await routes(page);
    await page.goto(BASE + '/transport/planning');
    try { await page.getByRole('tab', { name: /Optimise/ }).waitFor({ timeout: 20000 }); } catch (e) { await page.screenshot({ path: OUT + '/fail.png' }); console.log(errors.join(' | '), await page.evaluate(() => document.body.innerText.slice(0, 800))); throw e; }
    await shot(page, `${w}-01-optimise-empty`);
    // Start without weights: explicit-weights refusal.
    await pick(page, '#opt-shifts', ['Morning']);
    await page.getByRole('button', { name: /^Optimise$/ }).click();
    await shot(page, `${w}-02-optimise-validation`);
    await page.reload();
    await page.getByRole('tab', { name: /Optimise/ }).waitFor();
    await optimise(page, ['Van 01', 'Van 02', 'Car 03'], [2, 5, 3, 4, 10]);
    await page.getByRole('button', { name: /^Optimise$/ }).click();
    await page.waitForTimeout(2200);
    await shot(page, `${w}-03-job-progress`);
    await page.getByRole('link', { name: 'Review plan' }).waitFor({ timeout: 20000 });
    await shot(page, `${w}-04-job-done`);
    // Second scenario with two vehicles for compare.
    await page.getByRole('tab', { name: /Optimise/ }).click(); await pick(page, '#opt-vehicles', ['Car 03']);
    await page.getByRole('button', { name: /^Optimise$/ }).click();
    await page.waitForTimeout(8000);
    await page.getByRole('tab', { name: /Plans/ }).click();
    await shot(page, `${w}-05-plans`);
    for (const cb of await page.getByRole('checkbox').all()) await cb.click();
    await page.getByRole('tab', { name: /Compare/ }).click();
    await shot(page, `${w}-06-compare-weighted`);
    // Plan review of the first plan.
    await page.getByRole('tab', { name: /Plans/ }).click();
    await page.getByRole('link', { name: /Morning/ }).first().click();
    await page.getByText('Unassigned passengers').waitFor();
    await shot(page, `${w}-07-review`);
    await page.getByRole('button', { name: /Move .* down/ }).first().click();
    await page.waitForTimeout(800);
    await shot(page, `${w}-08-review-after-move-down`);
    await page.getByRole('button', { name: /^Pin$/ }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Move to/ }).nth(1).click();
    await shot(page, `${w}-09-move-dialog`);
    await page.getByRole('button', { name: /^Move$/ }).click();
    await page.waitForTimeout(800);
    await shot(page, `${w}-10-after-move-recheck`);
    await page.getByRole('button', { name: /Publish…/ }).click();
    await shot(page, `${w}-11-publish-confirm`);
    const ack = page.getByRole('dialog').getByRole('checkbox');
    if (await ack.count()) await ack.click();
    await page.getByRole('dialog').getByRole('button', { name: /^Publish$/ }).click();
    await page.getByText('Published to dispatch').waitFor();
    await shot(page, `${w}-12-published-links`);
    // Engine down.
    await page.evaluate(() => sessionStorage.setItem('e4g.mode', 'engine-down'));
    await page.goto(BASE + '/transport/planning');
    await page.getByRole('tab', { name: /Optimise/ }).waitFor();
    await shot(page, `${w}-13-engine-down`);
    await page.evaluate(() => sessionStorage.setItem('e4g.mode', '1'));
    report.push({ name: `${w}-errors`, errors: [...errors] });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  process.exit(1);
});
