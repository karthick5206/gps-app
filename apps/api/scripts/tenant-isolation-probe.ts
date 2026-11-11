/*
 * Tenant-isolation probes for VeeTrax — ASSESSMENT INSTANCE ONLY.
 *
 * Re-runnable black-box probe. Exercises the isolation boundaries that were NOT already
 * covered by docs/modernization/02-role-permission-matrix.md §4:
 *   1. Socket.IO /live realtime fan-out (cross-tenant subscribe, Viewer scope, F-1 / R-14: socket closed on logout)
 *   2. File-serving endpoints (documents, expense photos, attendance selfies, driver-event media,
 *      report-run files, invoice/credit-note PDFs, /downloads + path traversal)
 *   3. Partner (reseller) boundaries
 *   4. Webhook company scoping (delivery records + live local listener)
 *
 * Prints a PASS/FAIL table and exits non-zero on any FAIL.
 *
 * SAFETY: defaults target the isolated instance on :4100 / DB veetracer_assess. It refuses to run
 * against :4000 (production) unless ALLOW_PROD=1 is explicitly set (it never should be here).
 *
 * Run:
 *   cd apps/api
 *   PATH="/c/Program Files/nodejs:$PATH" npx tsx scripts/tenant-isolation-probe.ts
 * Env overrides: BASE_URL, WS_ORIGIN, SA_EMAIL/SA_PASS, A_EMAIL/A_PASS, B_EMAIL/B_PASS,
 *   VIEWER_EMAIL/VIEWER_PASS, A_COMPANY_ID, B_COMPANY_ID, A_VEHICLE_ID.
 */
import { io, Socket } from 'socket.io-client';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4100/api';
const WS_ORIGIN = process.env.WS_ORIGIN ?? BASE_URL.replace(/\/api$/, '');

const CRED = {
  sa: { email: process.env.SA_EMAIL ?? 'admin@veetracer.local', pass: process.env.SA_PASS ?? 'Admin@12345' },
  a: { email: process.env.A_EMAIL ?? 'demo.admin@veetracer.local', pass: process.env.A_PASS ?? 'Demo@12345' },
  b: { email: process.env.B_EMAIL ?? 'beta.admin@assess.test', pass: process.env.B_PASS ?? 'Beta-Assess-7f3k9q' },
  viewer: { email: process.env.VIEWER_EMAIL ?? 'viewer@veetracer.local', pass: process.env.VIEWER_PASS ?? 'Demo@12345' },
};
const A_COMPANY_ID = process.env.A_COMPANY_ID ?? 'ebc261a1-1729-46cd-aa35-3e49c672655b';
const B_COMPANY_ID = process.env.B_COMPANY_ID ?? '37d6639e-f69a-43bc-815a-6a7409df73ff';
const A_VEHICLE_ID = process.env.A_VEHICLE_ID ?? '1a94dad1-6820-4740-85d0-af1f7bd1d152';

if (/:4000(\/|$)/.test(BASE_URL) && process.env.ALLOW_PROD !== '1') {
  console.error('Refusing to run against what looks like the production port :4000. This probe is for the isolated assessment instance only.');
  process.exit(2);
}

// ─────────────────────────── result table ───────────────────────────
type Status = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';
interface Row { group: string; probe: string; expected: string; actual: string; status: Status; }
const rows: Row[] = [];
const rec = (group: string, probe: string, expected: string, actual: string, status: Status) => {
  rows.push({ group, probe, expected, actual, status });
  const tag = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : status;
  console.log(`[${tag}] ${group} :: ${probe} — ${actual}`);
};
/** PASS when cond, else FAIL. */
const expect = (group: string, probe: string, expected: string, cond: boolean, actual: string) =>
  rec(group, probe, expected, actual, cond ? 'PASS' : 'FAIL');

// ─────────────────────────── http helpers ───────────────────────────
interface Resp { status: number; json: any; text: string; headers: Headers; }
async function http(method: string, path: string, token?: string, body?: any, isForm = false): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: any;
  if (body !== undefined) {
    if (isForm) payload = body;
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: any = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-json (e.g. file) */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function login(c: { email: string; pass: string }): Promise<string> {
  return (await loginPair(c)).accessToken;
}
/** Login returning both tokens (a separate session, so logging it out leaves the other probes' tokens valid). */
async function loginPair(c: { email: string; pass: string }): Promise<{ accessToken: string; refreshToken: string }> {
  const r = await http('POST', '/auth/login', undefined, { email: c.email, password: c.pass });
  if (r.status !== 200 || !r.json?.accessToken) throw new Error(`login failed for ${c.email}: ${r.status} ${r.text.slice(0, 120)}`);
  return { accessToken: r.json.accessToken as string, refreshToken: r.json.refreshToken as string };
}
/** Raw fetch that does not parse the body — used to confirm a file actually streams. */
async function fetchRaw(path: string, token?: string): Promise<{ status: number; bytes: number; ctype: string | null }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf.length, ctype: res.headers.get('content-type') };
}

// tiny valid 1x1 PNG (correct magic bytes so the upload signature check passes)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// ─────────────────────────── socket helper ───────────────────────────
interface Capture { batches: any[][]; alerts: any[]; objectIds: Set<string>; }
function openSocket(token: string, companyId?: string): { socket: Socket; cap: Capture; connected: Promise<void>; connErr: Promise<Error> } {
  const cap: Capture = { batches: [], alerts: [], objectIds: new Set() };
  const socket = io(`${WS_ORIGIN}/live`, { transports: ['websocket'], auth: { token, ...(companyId ? { companyId } : {}) }, reconnection: false, timeout: 8000 });
  socket.on('live:batch', (b: any[]) => { cap.batches.push(b); for (const o of b ?? []) if (o?.objectId) cap.objectIds.add(o.objectId); });
  socket.on('alert', (a: any) => cap.alerts.push(a));
  const connected = new Promise<void>((res) => socket.on('connect', () => res()));
  const connErr = new Promise<Error>((res) => socket.on('connect_error', (e: Error) => res(e)));
  return { socket, cap, connected, connErr };
}

// =====================================================================
async function probeSockets(tokens: { a: string; b: string; viewer: string }, viewerAllowed: Set<string>) {
  const G = '1. Socket.IO /live';

  // Precondition: is tenant A live data actually flowing? (so "B sees none" is meaningful)
  const A = openSocket(tokens.a);
  await Promise.race([A.connected, A.connErr, sleep(8000)]);
  await sleep(12000);
  const aStreaming = A.cap.batches.length > 0;
  rec(G, 'tenant A own stream (precondition)', 'A receives its own live:batch', aStreaming
    ? `A received ${A.cap.batches.length} batches covering ${A.cap.objectIds.size} objects`
    : 'A received NO batches in 12s (simulator may be idle) — B-isolation below still holds trivially', aStreaming ? 'INFO' : 'INFO');

  // 1b. Tenant B connects with companyId=A spoof + tries every plausible subscribe/join event for A.
  const B = openSocket(tokens.b, A_COMPANY_ID);
  const bConn = await Promise.race([B.connected.then(() => 'ok' as const), B.connErr.then((e) => e), sleep(8000).then(() => 'timeout' as const)]);
  if (bConn === 'ok') {
    // The gateway registers no @SubscribeMessage handlers, but prove it: fire arbitrary room/subscribe events for A.
    for (const ev of ['subscribe', 'join', 'live:subscribe', 'room', 'company', 'watch']) {
      B.socket.emit(ev, { companyId: A_COMPANY_ID, objectIds: [A_VEHICLE_ID, ...viewerAllowed], objectId: A_VEHICLE_ID });
    }
    await sleep(10000);
    const leaked = [...B.cap.objectIds];
    expect(G, 'B subscribe/join to tenant A (companyId spoof in handshake + emitted events)',
      'B receives zero A data over ~10s', B.cap.batches.length === 0 && B.cap.alerts.length === 0 && leaked.length === 0,
      `B batches=${B.cap.batches.length} alerts=${B.cap.alerts.length} leakedObjects=${leaked.length}`);
  } else {
    // Connection refused is also acceptable isolation (B has no vehicles → still should connect, but either way no data).
    rec(G, 'B subscribe/join to tenant A', 'B receives zero A data', `B socket did not connect (${String(bConn)}) — no data path`, 'PASS');
  }
  B.socket.close();

  // 1c. Viewer (3 vehicles) receives only its allowed objects.
  const V = openSocket(tokens.viewer);
  await Promise.race([V.connected, V.connErr, sleep(8000)]);
  await sleep(12000);
  const vSeen = [...V.cap.objectIds];
  const outOfScope = vSeen.filter((id) => !viewerAllowed.has(id));
  if (vSeen.length === 0) {
    rec(G, 'Viewer scope (3 vehicles)', 'only allowed objectIds', 'Viewer received no batches in 12s (idle simulator) — cannot confirm positively', 'INFO');
  } else {
    expect(G, 'Viewer scope (3 vehicles)', 'every streamed objectId is within the Viewer\'s 3 allowed',
      outOfScope.length === 0, `Viewer saw ${vSeen.length} objects, out-of-scope=${outOfScope.length} ${outOfScope.slice(0, 3).join(',')}`);
  }
  V.socket.close();

  // 1d. F-1 / R-14 (AZ-3), fixed in v1.8.2 G5: logout closes the session's live socket on the server.
  //     PASS = disconnected with 'io server disconnect' within 5 s, no live:batch / alert after 5 s, and the same
  //     access token is refused when it reconnects.
  const pair = await loginPair(CRED.a);
  const A2 = openSocket(pair.accessToken);
  const a2Conn = await Promise.race([A2.connected.then(() => 'ok' as const), A2.connErr.then((e) => e), sleep(8000).then(() => 'timeout' as const)]);
  const a2Disc = new Promise<string>((res) => A2.socket.on('disconnect', (reason) => res(reason)));
  await sleep(1500);
  const t0 = Date.now();
  const lo = await http('POST', '/auth/logout', undefined, { refreshToken: pair.refreshToken });
  const reason = await Promise.race([a2Disc, sleep(5000).then(() => 'still connected after 5s')]);
  const discMs = Date.now() - t0;
  const atFive = A2.cap.batches.length + A2.cap.alerts.length;
  await sleep(5000);
  const late = A2.cap.batches.length + A2.cap.alerts.length - atFive;
  A2.socket.close();
  const A3 = openSocket(pair.accessToken);
  const reconnect = await Promise.race([A3.connected.then(() => 'connected' as const), A3.connErr.then((e) => `refused (${e.message})`), sleep(8000).then(() => 'timeout' as const)]);
  A3.socket.close();
  expect(G, 'F-1 (AZ-3): socket after user logout', "'io server disconnect' ≤5 s, 0 events after 5 s, reconnect refused",
    a2Conn === 'ok' && lo.status === 200 && reason === 'io server disconnect' && late === 0 && reconnect.startsWith('refused'),
    `connect=${String(a2Conn)} logout=${lo.status} disconnect=${reason} in ${discMs}ms, events after 5s=${late}${aStreaming ? '' : ' (no data flowing)'}, reconnect=${reconnect}`);
}

// =====================================================================
async function probeFiles(tok: { sa: string; a: string; b: string; viewer: string }) {
  const G = '2. File downloads';

  // ---- documents ----
  let docId: string | undefined;
  const mk = await http('POST', '/documents', tok.a, { objectId: A_VEHICLE_ID, type: 'INSURANCE', number: 'ISO-PROBE', expiresOn: '2027-01-01' });
  if (mk.status >= 200 && mk.status < 300 && mk.json?.id) {
    docId = mk.json.id;
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'probe.png');
    const up = await http('POST', `/documents/${docId}/file`, tok.a, fd, true);
    const aGet = await fetchRaw(`/documents/${docId}/file`, tok.a);
    const bGet = await http('GET', `/documents/${docId}/file`, tok.b);
    expect(G, 'document file: tenant A owns, tenant B fetches', 'A=200 with bytes, B=403/404',
      aGet.status === 200 && aGet.bytes > 0 && (bGet.status === 403 || bGet.status === 404),
      `upload=${up.status} A=${aGet.status}/${aGet.bytes}b B=${bGet.status}`);
  } else {
    rec(G, 'document file', 'create A document', `could not create A document (${mk.status} ${mk.text.slice(0, 80)})`, 'SKIP');
  }

  // ---- expense receipt photo ----
  const ex = await http('POST', '/expenses', tok.a, { objectId: A_VEHICLE_ID, kind: 'FUEL', at: '2026-11-09T06:00:00.000Z', amountPaise: 12345, litres: 10, fullTank: true });
  if (ex.status >= 200 && ex.status < 300 && ex.json?.id) {
    const exId = ex.json.id;
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'bill.png');
    const up = await http('POST', `/expenses/${exId}/photo`, tok.a, fd, true);
    const aGet = await fetchRaw(`/expenses/${exId}/photo`, tok.a);
    const bGet = await http('GET', `/expenses/${exId}/photo`, tok.b);
    expect(G, 'expense receipt photo: A owns, B fetches', 'A=200 with bytes, B=403/404',
      aGet.status === 200 && aGet.bytes > 0 && (bGet.status === 403 || bGet.status === 404),
      `upload=${up.status} A=${aGet.status}/${aGet.bytes}b B=${bGet.status}`);
  } else {
    rec(G, 'expense receipt photo', 'create A expense', `could not create A expense (${ex.status} ${ex.text.slice(0, 80)})`, 'SKIP');
  }

  // ---- attendance selfie (B cannot even address an A object) ----
  const sB = await http('GET', `/attendance/selfie?objectId=${A_VEHICLE_ID}&day=2026-11-09`, tok.b);
  expect(G, 'attendance selfie of an A object fetched by B', 'B=403/404 (object out of B scope)',
    sB.status === 403 || sB.status === 404, `B=${sB.status}`);
  const vB = await http('GET', `/attendance/video?objectId=${A_VEHICLE_ID}&day=2026-11-09`, tok.b);
  expect(G, 'attendance video of an A object fetched by B', 'B=403/404',
    vB.status === 403 || vB.status === 404, `B=${vB.status}`);

  // ---- driver-event media (signed-token endpoint) ----
  // Prefer an event that actually carries media so we can test the signed-token binding.
  let deList = await http('GET', '/driver-events?page=1&hasPhoto=true', tok.a);
  let aEvent = deList.json?.items?.[0];
  if (!aEvent) { deList = await http('GET', '/driver-events?page=1', tok.a); aEvent = deList.json?.items?.[0]; }
  // cross-tenant read of the event detail
  if (aEvent?.id) {
    const bDetail = await http('GET', `/driver-events/${aEvent.id}`, tok.b);
    expect(G, 'driver-event detail of an A event fetched by B', 'B=403/404',
      bDetail.status === 403 || bDetail.status === 404, `B=${bDetail.status}`);
  }
  // find a media URL (carries the signed token) from A's detail and test token binding
  let mediaUrl: string | undefined;
  if (aEvent?.id) {
    const aDetail = await http('GET', `/driver-events/${aEvent.id}`, tok.a);
    const media = aDetail.json?.media ?? [];
    mediaUrl = media[0]?.url ?? aDetail.json?.thumbnailUrl ?? undefined;
  }
  if (mediaUrl) {
    const path = mediaUrl.replace(/^\/api/, '');
    const good = await fetchRaw(path);
    // tamper: flip the media id in the path but keep the token (claims.m must match the path id → 404)
    const [p, q] = path.split('?');
    const parts = p.split('/'); const realId = parts[parts.length - 1];
    const otherId = realId.replace(/[0-9a-f]$/i, (c) => (c === 'a' ? 'b' : 'a'));
    const mismatch = await fetchRaw(`/driver-events/media/${otherId}?${q}`);
    const noToken = await fetchRaw(`/driver-events/media/${realId}`);
    expect(G, 'driver-event media signed-token binding', 'valid token streams, wrong-id / missing token = 404',
      good.status === 200 && mismatch.status === 404 && noToken.status === 404,
      `valid=${good.status}/${good.bytes}b wrongId=${mismatch.status} noToken=${noToken.status}`);
  } else {
    rec(G, 'driver-event media signed-token binding', 'A media URL', 'no driver-event media present on A to test', 'SKIP');
  }

  // ---- report-run files ----
  let runId: string | undefined;
  try {
    const sch = await http('POST', '/report-schedules', tok.a, {
      name: 'iso-probe', reportTypes: ['TRIP_SUMMARY'], frequency: 'DAILY', timeOfDay: '06:00', format: 'CSV', recipients: ['iso@assess.test'], isActive: false,
    });
    if (sch.json?.id) {
      const run = await http('POST', `/report-schedules/${sch.json.id}/run-now`, tok.a, {});
      if (run.json?.id) runId = run.json.id;
    }
  } catch { /* best effort */ }
  if (!runId) {
    const existing = await http('GET', '/report-runs', tok.a);
    runId = existing.json?.[0]?.id ?? existing.json?.items?.[0]?.id;
  }
  if (runId) {
    const aGet = await http('GET', `/report-runs/${runId}/file`, tok.a);
    const bGet = await http('GET', `/report-runs/${runId}/file`, tok.b);
    expect(G, 'report-run file: A run fetched by B', 'B=403/404 (A may be 200/404 depending on file)',
      bGet.status === 403 || bGet.status === 404, `A=${aGet.status} B=${bGet.status}`);
  } else {
    // no A run available: prove B cannot read an arbitrary run id and sees an empty list
    const rnd = '00000000-0000-4000-8000-000000000000';
    const bGet = await http('GET', `/report-runs/${rnd}/file`, tok.b);
    expect(G, 'report-run file: B fetches an arbitrary run id', 'B=404 (company-scoped)',
      bGet.status === 404, `B=${bGet.status} (no A run existed to seed; see code evidence)`);
  }

  // ---- invoice / credit-note PDFs ----
  const aInv = await http('GET', '/licences/invoices', tok.a);
  const aInvId = Array.isArray(aInv.json) ? aInv.json[0]?.id : aInv.json?.items?.[0]?.id;
  if (aInvId) {
    const bPdf = await http('GET', `/licences/invoices/${aInvId}/pdf`, tok.b);
    expect(G, 'invoice PDF: A invoice fetched by B', 'B=403/404',
      bPdf.status === 403 || bPdf.status === 404, `B=${bPdf.status}`);
  } else {
    const rnd = '00000000-0000-4000-8000-000000000000';
    const bPdf = await http('GET', `/licences/invoices/${rnd}/pdf`, tok.b);
    expect(G, 'invoice PDF: B fetches an arbitrary invoice id', 'B=404 (company-scoped find)',
      bPdf.status === 404, `B=${bPdf.status} (no A invoice existed to seed)`);
  }
  // SA-only admin invoice/credit-note endpoints are denied to tenant admins
  const bAdminInv = await http('GET', '/licences/admin/invoices', tok.b);
  expect(G, 'SA admin invoices list reached by tenant-B admin', 'B=403 (needs sa_licences)',
    bAdminInv.status === 403, `B=${bAdminInv.status}`);

  // ---- /downloads path traversal ----
  const trav = [
    '/downloads/..%2f..%2f.env',
    '/downloads/..%2F..%2F..%2Fpackage.json',
    '/downloads/not-an-apk.txt',
  ];
  const results: string[] = [];
  let allBlocked = true;
  for (const p of trav) {
    const r = await fetchRaw(p);
    results.push(`${p.split('/').pop()}=${r.status}`);
    if (r.status === 200) allBlocked = false;
  }
  expect(G, '/downloads path traversal + non-APK name', 'all non-200 (APK_NAME regex gate)',
    allBlocked, results.join(' '));
}

// =====================================================================
async function probePartners(tok: { sa: string; a: string; b: string }) {
  const G = '3. Partner boundaries';
  // Partner whose HOME company is tenant A (so the existing A admin becomes a partner user). Idempotent:
  // reuse the partner from a previous run if one already has home = tenant A.
  let partnerId: string | undefined;
  const existing = await http('GET', '/licences/admin/partners', tok.sa);
  partnerId = (Array.isArray(existing.json) ? existing.json : []).find((p: any) => p.homeCompanyId === A_COMPANY_ID)?.id;
  if (!partnerId) {
    const create = await http('POST', '/licences/admin/partners', tok.sa, { name: `Assess Partner ${Date.now()}`, homeCompanyId: A_COMPANY_ID });
    if (create.status < 200 || create.status >= 300) {
      rec(G, 'partner setup', 'create partner (SA)', `failed: ${create.status} ${create.text.slice(0, 120)}`, 'FAIL');
      return;
    }
    partnerId = (create.json as any[]).find((p) => p.homeCompanyId === A_COMPANY_ID)?.id ?? (create.json as any[]).at(-1)?.id;
  }
  rec(G, 'partner setup', 'partner with home = tenant A (created or reused)', `partnerId=${partnerId}`, 'INFO');

  // An allocated customer company C linked to the partner. Reuse one from a previous run if present.
  let customerId: string | undefined;
  const pool = await http('GET', `/licences/admin/pools/partner/${partnerId}`, tok.sa);
  customerId = (pool.json?.customers ?? [])[0]?.companyId;
  if (!customerId) {
    const cCreate = await http('POST', '/admin/companies', tok.sa, {
      name: `Assess Customer ${Date.now()}`, accountType: 'BUSINESS',
      admin: { name: 'Cust Admin', email: `cust.${Date.now()}@assess.test`, password: 'Cust@12345' },
    });
    customerId = cCreate.json?.id ?? cCreate.json?.company?.id;
    if (customerId) {
      const link = await http('PATCH', `/licences/admin/companies/${customerId}/partner`, tok.sa, { partnerId });
      rec(G, 'customer link', 'link company C to partner', `companyC=${customerId} link=${link.status}`, 'INFO');
    } else {
      rec(G, 'customer link', 'create customer company C', `could not create C (${cCreate.status} ${cCreate.text.slice(0, 80)}) — positive case limited`, 'SKIP');
    }
  } else {
    rec(G, 'customer link', 'reuse allocated customer C', `companyC=${customerId}`, 'INFO');
  }

  // The partner user is tenant A's admin. Re-login A so its context reflects the new partner home.
  const aTok = await login(CRED.a);

  // Positive: partner can read its own partner overview.
  const own = await http('GET', '/licences/partner/overview', aTok);
  expect(G, 'partner user reads own partner overview', 'A(partner)=200',
    own.status === 200, `A=${own.status}`);

  // Positive: partner can read its allocated customer C.
  if (customerId) {
    const cust = await http('GET', `/licences/partner/customers/${customerId}/overview`, aTok);
    expect(G, 'partner reads its allocated customer C', 'A(partner)=200',
      cust.status === 200, `C overview=${cust.status}`);
  }

  // Negative: partner CANNOT read tenant B (not its customer).
  const bOverview = await http('GET', `/licences/partner/customers/${B_COMPANY_ID}/overview`, aTok);
  expect(G, 'partner reads a NON-customer (tenant B) overview', 'A(partner)=403 "not your customer"',
    bOverview.status === 403, `B overview=${bOverview.status} ${String(bOverview.json?.message ?? '').slice(0, 60)}`);

  const bInvoices = await http('GET', `/licences/partner/customers/${B_COMPANY_ID}/invoices`, aTok);
  expect(G, 'partner reads a NON-customer (tenant B) invoices', 'A(partner)=403',
    bInvoices.status === 403, `B invoices=${bInvoices.status}`);

  // Negative: partner offline payment cannot target a non-linked company (tenant B). Body is valid so we reach the auth guard.
  const pay = await http('POST', `/licences/partner/customers/${B_COMPANY_ID}/payments`, aTok, {
    items: [], renewSeatIds: [], mode: 'CASH', paidOn: '2026-11-09', amountPaise: 100,
  });
  expect(G, 'partner offline payment targeting non-customer (tenant B)', 'A(partner)=403 (not 2xx)',
    pay.status === 403, `payment=${pay.status} ${String(pay.json?.message ?? '').slice(0, 60)}`);

  // Negative: a non-partner user (tenant B admin) cannot use partner endpoints at all.
  const nonPartner = await http('GET', '/licences/partner/overview', tok.b);
  expect(G, 'non-partner user (tenant B) uses partner endpoint', 'B=403 "not a partner account"',
    nonPartner.status === 403, `B=${nonPartner.status} ${String(nonPartner.json?.message ?? '').slice(0, 60)}`);

  // Negative: SA-only partner admin management denied to tenant-B admin.
  const bAdminPartners = await http('GET', '/licences/admin/partners', tok.b);
  expect(G, 'SA partner admin list reached by tenant-B admin', 'B=403 (needs sa_licences)',
    bAdminPartners.status === 403, `B=${bAdminPartners.status}`);
}

// =====================================================================
async function probeWebhooks(tok: { sa: string; a: string; b: string }) {
  const G = '4. Webhooks';

  // Local sink on loopback (allowed on the non-production assessment instance).
  const got: { path: string; companyId: any; event: any; test: any }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { const j = JSON.parse(body); got.push({ path: req.url ?? '', companyId: j.companyId, event: j.type, test: j.test }); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const sink = (p: string) => `http://127.0.0.1:${port}${p}`;

  // Ensure both tenants can create a webhook (B needs an API_ACCESS seat).
  await http('POST', `/licences/admin/pools/company/${B_COMPANY_ID}/grant`, tok.sa, { type: 'API_ACCESS', quantity: 1, days: 365, reason: 'tenant-isolation assessment', plan: 'BASIC' });
  await http('POST', `/licences/admin/pools/company/${A_COMPANY_ID}/grant`, tok.sa, { type: 'API_ACCESS', quantity: 1, days: 365, reason: 'tenant-isolation assessment', plan: 'BASIC' });

  // Clean up any endpoints left by a previous run of this probe.
  for (const t of [tok.a, tok.b]) {
    const list = await http('GET', '/developer/webhooks', t);
    for (const ep of (Array.isArray(list.json) ? list.json : [])) if (/^tiso-/.test(ep.name)) await http('DELETE', `/developer/webhooks/${ep.id}`, t);
  }

  const mkEp = async (t: string, name: string, path: string) =>
    http('POST', '/developer/webhooks', t, { name, url: sink(path), events: ['alert.created', 'trip.completed', 'vehicle.status_changed'], isActive: true });

  const aEp = await mkEp(tok.a, 'tiso-a', '/a');
  const bEp = await mkEp(tok.b, 'tiso-b', '/b');
  let aEpId: string | undefined = aEp.json?.endpoint?.id;
  const bEpId: string | undefined = bEp.json?.endpoint?.id;
  if (!aEpId) {
    // Tenant A is already at its Developer-API plan webhook capacity — reuse an existing A endpoint
    // for the delivery-record isolation checks (its URL is elsewhere, so only /b receives at the sink).
    const list = await http('GET', '/developer/webhooks', tok.a);
    const arr = Array.isArray(list.json) ? list.json : [];
    aEpId = (arr.find((e: any) => e.isActive) ?? arr[0])?.id;
    rec(G, 'webhook A endpoint', 'create or reuse an A endpoint', `A create=${aEp.status} (at capacity) → reusing existing endpoint ${aEpId}`, 'INFO');
  }
  if (!aEpId || !bEpId) {
    rec(G, 'webhook setup', 'have A and B endpoints', `A=${aEp.status}/${aEpId} B=${bEp.status}/${bEpId} ${bEp.text.slice(0, 80)}`, 'FAIL');
    server.close();
    return;
  }

  // Fire a test delivery from each tenant.
  const aTest = await http('POST', `/developer/webhooks/${aEpId}/test`, tok.a, { event: 'alert.created' });
  const bTest = await http('POST', `/developer/webhooks/${bEpId}/test`, tok.b, { event: 'alert.created' });

  // Cross-tenant read isolation of delivery records (works regardless of the sender worker).
  const aDelivId = aTest.json?.id;
  if (aDelivId) {
    const bRead = await http('GET', `/developer/webhook-deliveries/${aDelivId}`, tok.b);
    expect(G, 'tenant B reads tenant A webhook delivery record', 'B=404 (company-scoped)',
      bRead.status === 404, `B=${bRead.status}`);
  }
  const bListsA = await http('GET', `/developer/webhooks/${aEpId}/deliveries`, tok.b);
  expect(G, 'tenant B lists tenant A endpoint deliveries', 'B=404 (endpoint not found for B)',
    bListsA.status === 404, `B=${bListsA.status}`);

  // Wait for the sender worker (notifier) to deliver, if it is running.
  await sleep(12000);
  const atHookA = got.filter((g) => g.path.startsWith('/a'));
  const atHookB = got.filter((g) => g.path.startsWith('/b'));
  const aAllA = atHookA.every((g) => g.companyId === A_COMPANY_ID);
  const bAllB = atHookB.every((g) => g.companyId === B_COMPANY_ID);
  const noCross = atHookA.every((g) => g.companyId !== B_COMPANY_ID) && atHookB.every((g) => g.companyId !== A_COMPANY_ID);
  if (got.length > 0) {
    expect(G, 'live deliveries carry only the owning company (loopback sink)', 'sink /a sees only A, /b only B',
      aAllA && bAllB && noCross, `/a=${atHookA.length}(A-only=${aAllA}) /b=${atHookB.length}(B-only=${bAllB}) noCross=${noCross}`);
  } else {
    rec(G, 'live deliveries to loopback sink', 'sink receives per-company payloads', 'no deliveries arrived in 12s (webhook sender/notifier worker not running on this instance) — record-level isolation proven above + fan-out is companyId-scoped in code (webhooks/fanout.ts queueEvent)', 'INFO');
  }

  // Code-guarantee note for the write-up.
  rec(G, 'fan-out company scoping (code)', 'queueEvent filters endpoints by event.companyId', 'webhooks/fanout.ts queueEvent: where { companyId: e.companyId } — B endpoints never match an A event', 'INFO');

  // tidy up (only endpoints this run created; never a reused pre-existing one)
  if (aEp.json?.endpoint?.id) await http('DELETE', `/developer/webhooks/${aEp.json.endpoint.id}`, tok.a);
  await http('DELETE', `/developer/webhooks/${bEpId}`, tok.b);
  server.close();
}

// =====================================================================
async function main() {
  console.log(`Tenant-isolation probe → ${BASE_URL} (ws ${WS_ORIGIN})\n`);
  const sa = await login(CRED.sa);
  let a = await login(CRED.a);
  const b = await login(CRED.b);
  const viewer = await login(CRED.viewer);

  // Viewer's allowed object set from its own snapshot.
  const vSnap = await http('GET', '/live', viewer);
  const viewerAllowed = new Set<string>((Array.isArray(vSnap.json) ? vSnap.json : []).map((o: any) => o.objectId));
  console.log(`Viewer allowed objects: ${viewerAllowed.size} (${[...viewerAllowed].join(', ')})\n`);

  await probeFiles({ sa, a, b, viewer });
  await probeWebhooks({ sa, a, b });
  await probeSockets({ a, b, viewer }, viewerAllowed);
  // Partners last: it makes tenant A a partner home and re-logs-in A internally.
  await probePartners({ sa, a, b });

  // ─────────── summary table ───────────
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log('\n' + '='.repeat(140));
  console.log(`${pad('GROUP', 20)} ${pad('PROBE', 52)} ${pad('EXPECTED', 40)} ${pad('STATUS', 6)}`);
  console.log('-'.repeat(140));
  for (const r of rows) console.log(`${pad(r.group, 20)} ${pad(r.probe, 52)} ${pad(r.expected, 40)} ${pad(r.status, 6)}`);
  console.log('='.repeat(140));
  const c = { PASS: 0, FAIL: 0, INFO: 0, SKIP: 0 };
  for (const r of rows) c[r.status]++;
  console.log(`PASS=${c.PASS}  FAIL=${c.FAIL}  INFO=${c.INFO}  SKIP=${c.SKIP}  (total ${rows.length})`);
  if (c.FAIL > 0) { console.log('\nRESULT: FAIL — one or more isolation probes failed.'); process.exit(1); }
  console.log('\nRESULT: PASS — no isolation failures.');
  process.exit(0);
}

main().catch((e) => { console.error('Probe crashed:', e); process.exit(3); });
