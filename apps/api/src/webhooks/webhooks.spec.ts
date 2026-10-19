import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { postJson } from './http-post';
import { afterAttempt, retryDelaySec, WEBHOOK_MAX_ATTEMPTS } from './retry';
import { signatureHeader, signPayload, verifySignature } from './signing';
import { checkWebhookUrl, isPrivateAddress } from './url-guard';
import { alertEvents, vehicleState } from './events';

describe('webhook signing', () => {
  const body = '{"id":"evt_1","type":"alert.created"}';
  it('matches a known HMAC-SHA256 vector over "<t>.<body>"', () => {
    expect(signPayload('whsec_test_secret', 1700000000, body)).toBe('4777b3725e73c88cc7ce16eb3120109bfdf442392ee24e9e6ca13486189e1fe5');
    expect(signatureHeader('whsec_test_secret', 1700000000, body)).toBe('t=1700000000,v1=4777b3725e73c88cc7ce16eb3120109bfdf442392ee24e9e6ca13486189e1fe5');
  });
  it('verifies, and rejects tampered bodies, wrong secrets and stale timestamps', () => {
    const h = signatureHeader('whsec_test_secret', 1700000000, body);
    expect(verifySignature('whsec_test_secret', h, body, 1700000100)).toBe(true);
    expect(verifySignature('whsec_test_secret', h, `${body} `, 1700000100)).toBe(false);
    expect(verifySignature('whsec_other', h, body, 1700000100)).toBe(false);
    expect(verifySignature('whsec_test_secret', h, body, 1700001000)).toBe(false);
    expect(verifySignature('whsec_test_secret', 'garbage', body, 1700000100)).toBe(false);
  });
});

describe('SSRF guard', () => {
  it('classifies private, loopback, link-local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    }
  });

  const prod = { production: true, allowPrivate: false };
  const dev = { production: false, allowPrivate: true };
  it('requires https in production and refuses private targets', () => {
    expect(checkWebhookUrl('https://erp.example.com/hook', prod)).toBeNull();
    expect(checkWebhookUrl('http://erp.example.com/hook', prod)).toMatch(/https/);
    expect(checkWebhookUrl('https://127.0.0.1/hook', prod)).toMatch(/public/);
    expect(checkWebhookUrl('https://10.0.0.5/hook', prod)).toMatch(/public/);
    expect(checkWebhookUrl('https://[::1]/hook', prod)).toMatch(/public/);
    expect(checkWebhookUrl('https://localhost/hook', prod)).toMatch(/public/);
    expect(checkWebhookUrl('https://user:pw@erp.example.com/', prod)).toMatch(/password/);
    expect(checkWebhookUrl('not a url', prod)).toMatch(/valid/);
  });
  it('allows http://localhost during development only', () => {
    expect(checkWebhookUrl('http://localhost:3000/hook', dev)).toBeNull();
    expect(checkWebhookUrl('http://example.com/hook', dev)).toMatch(/https/);
  });

  describe('postJson', () => {
    let server: Server;
    let port: number;
    let hits = 0;
    beforeAll(async () => {
      server = createServer((req, res) => {
        hits++;
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/ok' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(5000));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('refuses loopback IPs and hostnames that resolve to private addresses', async () => {
      const before = hits;
      await expect(postJson(`http://127.0.0.1:${port}/ok`, '{}', {}, { timeoutMs: 2000, allowPrivate: false })).rejects.toThrow(/private/);
      await expect(postJson(`http://localhost:${port}/ok`, '{}', {}, { timeoutMs: 2000, allowPrivate: false })).rejects.toThrow(/private/);
      expect(hits).toBe(before);
    });

    it('posts when allowed, truncates the response and never follows redirects', async () => {
      const ok = await postJson(`http://127.0.0.1:${port}/ok`, '{}', {}, { timeoutMs: 2000, allowPrivate: true });
      expect(ok.status).toBe(200);
      expect(ok.body.length).toBe(2048);
      const before = hits;
      const r = await postJson(`http://127.0.0.1:${port}/redirect`, '{}', {}, { timeoutMs: 2000, allowPrivate: true });
      expect(r.status).toBe(302);
      expect(hits).toBe(before + 1);
    });
  });
});

describe('retry schedule and auto-disable', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  it('backs off 1 m, 5 m, 30 m, 2 h, 6 h, then gives up', () => {
    expect([1, 2, 3, 4, 5].map((a) => retryDelaySec(a))).toEqual([60, 300, 1800, 7200, 21600]);
    expect(retryDelaySec(6)).toBeNull();
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    const o = afterAttempt(1, false, 0, now);
    expect(o).toMatchObject({ status: 'RETRYING', consecutiveFailures: 1, disableEndpoint: false });
    expect(o.nextAttemptAt?.toISOString()).toBe('2026-10-19T10:01:00.000Z');
    expect(afterAttempt(3, false, 2, now).nextAttemptAt?.toISOString()).toBe('2026-10-19T10:30:00.000Z');
    expect(afterAttempt(6, false, 5, now)).toMatchObject({ status: 'FAILED', nextAttemptAt: null });
  });
  it('resets the failure streak on success', () => {
    expect(afterAttempt(3, true, 12, now)).toEqual({ status: 'SUCCEEDED', nextAttemptAt: null, consecutiveFailures: 0, disableEndpoint: false });
  });
  it('disables the endpoint exactly when the streak reaches the limit', () => {
    expect(afterAttempt(1, false, 48, now).disableEndpoint).toBe(false);
    expect(afterAttempt(1, false, 49, now)).toMatchObject({ status: 'FAILED', disableEndpoint: true, consecutiveFailures: 50 });
    expect(afterAttempt(1, false, 50, now).disableEndpoint).toBe(false);
  });
});

describe('event mapping', () => {
  it('maps alerts and statuses to webhook events', () => {
    expect(alertEvents('OVERSPEED')).toEqual(['alert.created']);
    expect(alertEvents('GEOFENCE_ENTER')).toEqual(['alert.created', 'geofence.enter']);
    expect(alertEvents('GEOFENCE_EXIT')).toEqual(['alert.created', 'geofence.exit']);
    expect(alertEvents('FUEL_DRAIN')).toEqual(['alert.created', 'fuel.event']);
    expect(vehicleState('OVERSPEED')).toBe('moving');
    expect(vehicleState('OFF')).toBe('stopped');
    expect(vehicleState('NO_DATA')).toBeNull();
  });
});
