import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedis, redactRedisUrl, redisOptions, redisTlsOptions } from './connection';

describe('cache connection options (TLS + ACL)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-tls-'));
    writeFileSync(join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('plain redis:// URL: no TLS (unchanged behaviour)', () => {
    expect(redisTlsOptions('redis://localhost:6379', {})).toBeUndefined();
    expect(redisOptions('redis://localhost:6379', { maxRetriesPerRequest: 3 }, {})).toEqual({ maxRetriesPerRequest: 3 });
  });

  it('rediss:// enables TLS; a self-managed CA, server name and client cert come from REDIS_TLS_*', () => {
    const env = { REDIS_TLS_CA_FILE: join(dir, 'ca.crt'), REDIS_TLS_SERVERNAME: 'valkey.veetrax.internal' };
    const tls = redisTlsOptions('rediss://veetrax:pw@10.0.0.5:6380', env)!;
    expect(String(tls.ca)).toContain('BEGIN CERTIFICATE');
    expect(tls.servername).toBe('valkey.veetrax.internal');
    expect(tls).not.toHaveProperty('rejectUnauthorized'); // certificate checks are never switched off
    expect(redisTlsOptions('rediss://h:6380', {})).toEqual({});
    expect(redisTlsOptions('redis://h:6380', { REDIS_TLS: 'on' })).toEqual({});
  });

  it('caller options are kept alongside TLS', () => {
    const o = redisOptions('rediss://h:6380', { enableOfflineQueue: false, commandTimeout: 5000 }, { REDIS_TLS_SERVERNAME: 'x' });
    expect(o).toMatchObject({ enableOfflineQueue: false, commandTimeout: 5000, tls: { servername: 'x' } });
  });

  it('ioredis takes the ACL user and password from the URL, and TLS from rediss://', () => {
    const r = createRedis('rediss://veetrax:p%40ss%3Aword@10.0.0.5:6380/0', { lazyConnect: true });
    expect(r.options.username).toBe('veetrax');
    expect(r.options.password).toBe('p@ss:word');
    expect(r.options.host).toBe('10.0.0.5');
    expect(r.options.port).toBe(6380);
    expect(r.options.tls).toBeDefined();
    // duplicate() (used for subscriber connections) keeps the same credentials and TLS settings.
    const d = r.duplicate();
    expect([d.options.username, d.options.password, !!d.options.tls]).toEqual(['veetrax', 'p@ss:word', true]);
    r.disconnect();
    d.disconnect();
  });

  it('redacts the password for logs', () => {
    expect(redactRedisUrl('rediss://veetrax:secret@h:6380')).toBe('rediss://veetrax:***@h:6380');
    expect(redactRedisUrl('redis://:secret@h:6379')).toBe('redis://:***@h:6379');
    expect(redactRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
  });
});
