/*
 * Black-box isolation probes for Device Inventory, SIM management and the tenant "Devices & SIMs" view.
 * Modelled on scripts/tenant-isolation-probe.ts. SCRATCH / ASSESSMENT INSTANCES ONLY.
 *
 * Checks:
 *   1. Platform-only routes (/inventory/*, /sims/*) refuse tenant admins (403) and anonymous callers (401).
 *   2. /asset-links is tenant-scoped: own vehicle / device 200; another company's vehicle / device, platform stock
 *      devices and an X-Company-Id switch attempt all 404; the tenant payload carries no cost / ICCID / plan data.
 *
 * Setup: if no second tenant exists, the probe creates "Isolation Probe Co" (+ admin user, one vehicle, one device)
 * through the Super Admin API of the instance under test.
 *
 * Run (worktree API on :4420, scratch DB):
 *   BASE_URL=http://localhost:4420/api npx tsx scripts/inventory-isolation-probe.ts
 * Refuses :4000 (production) outright.
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4420/api';
const SA = { email: process.env.SA_EMAIL ?? 'admin@veetracer.local', pass: process.env.SA_PASS ?? 'Admin@12345' };
const A = { email: process.env.A_EMAIL ?? 'demo.admin@veetracer.local', pass: process.env.A_PASS ?? 'Demo@12345' };
const B = { email: 'probe.b.admin@isolation.test', pass: 'Probe-B-9x7k2m!Q' };

if (/:4000(\/|$)/.test(BASE_URL)) {
  console.error('Refusing to run against port 4000 (production).');
  process.exit(2);
}

type Status = 'PASS' | 'FAIL';
const rows: { probe: string; expected: string; actual: string; status: Status }[] = [];
const rec = (probe: string, expected: string, actual: string, ok: boolean) => rows.push({ probe, expected, actual, status: ok ? 'PASS' : 'FAIL' });

async function http(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> & { items?: Record<string, unknown>[] } };
}
async function login(c: { email: string; pass: string }): Promise<string | null> {
  const r = await http('POST', '/auth/login', undefined, { email: c.email, password: c.pass });
  return r.status === 200 ? (r.json.accessToken as string) : null;
}

async function main() {
  const sa = await login(SA);
  const a = await login(A);
  if (!sa || !a) throw new Error('Super Admin or tenant A login failed');

  // Tenant B (created once on the scratch instance).
  let b = await login(B);
  if (!b) {
    const created = await http('POST', '/admin/companies', sa, { name: 'Isolation Probe Co', accountType: 'BUSINESS', admin: { name: 'Probe B Admin', email: B.email, password: B.pass } });
    if (created.status >= 300) throw new Error(`could not create tenant B: ${created.status} ${JSON.stringify(created.json)}`);
    b = await login(B);
  }
  if (!b) throw new Error('tenant B login failed');

  const aObjects = (await http('GET', '/objects?pageSize=100', a)).json.items ?? [];
  const aVehicle = aObjects.find((o) => o.device) as { id: string; device: { id: string } } | undefined;
  if (!aVehicle) throw new Error('tenant A has no vehicle with a device');
  let bObjects = (await http('GET', '/objects?pageSize=100', b)).json.items ?? [];
  if (!bObjects.some((o) => o.device)) {
    const model = ((await http('GET', '/device-models?pageSize=50', sa)).json.items ?? []).find((m) => m.protocol !== 'MOBILE') as { id: string };
    const bCompany = ((await http('GET', '/admin/companies?pageSize=50', sa)).json.items ?? []).find((c) => c.name === 'Isolation Probe Co') as { id: string };
    const dev = await http('POST', '/admin/devices', sa, { uniqueId: `PROBEB${Date.now().toString().slice(-8)}`, modelId: model.id, companyId: bCompany.id }, { 'X-Licence-Override': 'Isolation probe on scratch DB' });
    await http('POST', '/objects', b, { name: 'Probe B van', type: 'VEHICLE', deviceId: (dev.json as { id: string }).id });
    bObjects = (await http('GET', '/objects?pageSize=100', b)).json.items ?? [];
  }
  const bVehicle = bObjects.find((o) => o.device) as { id: string; device: { id: string } } | undefined;
  if (!bVehicle) throw new Error('tenant B has no vehicle with a device');
  const stockDevice = ((await http('GET', '/inventory/stock?stockStatus=IN_STOCK&pageSize=1', sa)).json.items ?? [])[0] as { deviceId: string } | undefined;
  const bCompanyId = ((await http('GET', '/admin/companies?pageSize=50', sa)).json.items ?? []).find((c) => c.name === 'Isolation Probe Co')?.id as string;

  // 1. Platform-only routes.
  const platform: [string, string, unknown?][] = [
    ['GET', '/inventory/stock'],
    ['GET', '/inventory/dashboard'],
    ['GET', '/inventory/movements'],
    ['GET', '/inventory/locations'],
    ['POST', '/inventory/receipts', { locationId: '00000000-0000-0000-0000-000000000000', items: [{ uniqueId: 'X1234' }] }],
    ['POST', '/inventory/replace', { objectId: aVehicle.id, newDeviceId: aVehicle.device.id, reason: 'probe' }],
    ['GET', `/inventory/replace/candidates?objectId=${aVehicle.id}`],
    ['GET', '/sims'],
    ['GET', '/sims/summary'],
    ['GET', '/sims/renewals'],
    ['POST', '/sims', { iccid: '8991000000000000001', providerId: '00000000-0000-0000-0000-000000000000' }],
    ['POST', '/sims/import', { csv: 'iccid\n8991000000000000001' }],
  ];
  for (const [method, path, body] of platform) {
    const r = await http(method, path, a, body);
    rec(`tenant A ${method} ${path}`, '403', String(r.status), r.status === 403);
    const anon = await http(method, path, undefined, body);
    rec(`anonymous ${method} ${path}`, '401', String(anon.status), anon.status === 401);
  }

  // 2. Tenant-scoped asset view.
  const own = await http('GET', `/asset-links/objects/${aVehicle.id}`, a);
  rec('A reads own vehicle Devices & SIMs', '200', String(own.status), own.status === 200);
  const text = JSON.stringify(own.json);
  rec('A payload has no cost / price / ICCID / plan / provider', 'absent', /cost|price|iccid|"plan|provider|imsi/i.test(text) ? 'present' : 'absent', !/cost|price|iccid|"plan|provider|imsi/i.test(text));
  const ownDev = await http('GET', `/asset-links/devices/${aVehicle.device.id}`, a);
  rec('A reads own device', '200', String(ownDev.status), ownDev.status === 200);
  for (const [label, path, token, headers] of [
    ["A reads B's vehicle", `/asset-links/objects/${bVehicle.id}`, a, {}],
    ["A reads B's device", `/asset-links/devices/${bVehicle.device.id}`, a, {}],
    ["B reads A's vehicle", `/asset-links/objects/${aVehicle.id}`, b, {}],
    ["B reads A's device", `/asset-links/devices/${aVehicle.device.id}`, b, {}],
    ['A reads a platform stock device', `/asset-links/devices/${stockDevice?.deviceId ?? '00000000-0000-0000-0000-000000000000'}`, a, {}],
    ["A with X-Company-Id of B reads B's vehicle", `/asset-links/objects/${bVehicle.id}`, a, { 'X-Company-Id': bCompanyId }],
  ] as [string, string, string, Record<string, string>][]) {
    const r = await http('GET', path, token, undefined, headers);
    rec(label, '404', String(r.status), r.status === 404);
  }
  const anonLinks = await http('GET', `/asset-links/objects/${aVehicle.id}`);
  rec('anonymous reads asset links', '401', String(anonLinks.status), anonLinks.status === 401);

  const width = Math.max(...rows.map((r) => r.probe.length));
  for (const r of rows) console.log(`${r.status}  ${r.probe.padEnd(width)}  expected ${r.expected.padEnd(6)} got ${r.actual}`);
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
