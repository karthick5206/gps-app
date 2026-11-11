import { displayHost, resolveApiHost } from './api-host';

describe('resolveApiHost (API_HOST)', () => {
  it('unset in production: loopback, behind the reverse proxy', () => {
    expect(resolveApiHost(undefined, 'production')).toEqual({ host: '127.0.0.1', exposure: 'loopback' });
    expect(resolveApiHost('  ', 'production')).toEqual({ host: '127.0.0.1', exposure: 'loopback' });
  });

  it('unset outside production: Node default (every interface), as before', () => {
    expect(resolveApiHost(undefined, undefined)).toEqual({ host: undefined, exposure: 'all-interfaces' });
    expect(resolveApiHost('', 'development')).toEqual({ host: undefined, exposure: 'all-interfaces' });
    expect(resolveApiHost(undefined, 'test')).toEqual({ host: undefined, exposure: 'all-interfaces' });
  });

  it('loopback aliases', () => {
    expect(resolveApiHost('loopback', undefined)).toEqual({ host: '127.0.0.1', exposure: 'loopback' });
    expect(resolveApiHost('localhost', 'production')).toEqual({ host: '127.0.0.1', exposure: 'loopback' });
    expect(resolveApiHost('::1', 'production')).toEqual({ host: '::1', exposure: 'loopback' });
    expect(resolveApiHost('127.0.0.2', 'production')).toEqual({ host: '127.0.0.2', exposure: 'loopback' });
  });

  it('explicit private, all-interfaces and specific addresses (opt-in in production too)', () => {
    expect(resolveApiHost('10.8.0.1', 'production')).toEqual({ host: '10.8.0.1', exposure: 'private' });
    expect(resolveApiHost('192.168.1.20', 'production').exposure).toBe('private');
    expect(resolveApiHost('172.16.0.1', 'production').exposure).toBe('private');
    expect(resolveApiHost('fd00::1', 'production').exposure).toBe('private');
    expect(resolveApiHost('0.0.0.0', 'production')).toEqual({ host: '0.0.0.0', exposure: 'all-interfaces' });
    expect(resolveApiHost('::', 'production')).toEqual({ host: '::', exposure: 'all-interfaces' });
    expect(resolveApiHost('172.32.0.1', 'production').exposure).toBe('specific');
    expect(resolveApiHost('203.0.113.7', 'production').exposure).toBe('specific');
  });

  it('refuses host names and junk', () => {
    expect(() => resolveApiHost('api.example.com', 'production')).toThrow(/API_HOST/);
    expect(() => resolveApiHost('db', undefined)).toThrow(/API_HOST/);
    expect(() => resolveApiHost('300.1.1.1', 'production')).toThrow(/API_HOST/);
  });

  it('displays the bound address', () => {
    expect(displayHost({ host: undefined, exposure: 'all-interfaces' })).toBe('*');
    expect(displayHost({ host: '127.0.0.1', exposure: 'loopback' })).toBe('127.0.0.1');
    expect(displayHost({ host: '::1', exposure: 'loopback' })).toBe('[::1]');
  });
});
