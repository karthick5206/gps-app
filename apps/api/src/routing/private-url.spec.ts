import { isLocalHost } from '../monitoring/map-services';
import { privateServiceUrlProblem } from './private-url';

describe('privateServiceUrlProblem (self-hosted routing services)', () => {
  it.each([
    'http://127.0.0.1:8090',
    'http://localhost:8989',
    'http://[::1]:8090',
    'http://10.8.0.2:8090',
    'http://172.16.4.1:8090',
    'http://192.168.1.20:8090',
    'http://[fd00::2]:8090',
    'http://optimizer:8090',
    'http://gh.internal:8989',
    'https://router.lan/',
  ])('accepts %s', (url) => {
    expect(privateServiceUrlProblem(url, {})).toBeNull();
  });

  it.each([
    ['https://graphhopper.com/api/1', /not a loopback or private host/],
    ['http://8.8.8.8:8090', /not a loopback or private host/],
    ['http://172.32.0.1:8090', /not a loopback or private host/],
    ['http://optimizer.example.com', /not a loopback or private host/],
    ['ftp://127.0.0.1/x', /unsupported protocol/],
    ['http://user:pass@127.0.0.1:8090', /credentials/],
    ['not a url', /not a URL/],
  ])('refuses %s', (url, why) => {
    expect(privateServiceUrlProblem(url, {})).toMatch(why);
  });

  it('agrees with the map-service probes on what is local (one rule, isLocalHost)', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', 'martin', 'photon.local', '203.0.113.9', 'tiles.example.org']) {
      expect(privateServiceUrlProblem(`http://${host}:1`, {}) === null).toBe(isLocalHost(host));
    }
  });

  it('ROUTING_ALLOW_PUBLIC_ENGINE=1 is the explicit escape hatch, but never for credentials', () => {
    expect(privateServiceUrlProblem('https://router.example.com', { ROUTING_ALLOW_PUBLIC_ENGINE: '1' })).toBeNull();
    expect(privateServiceUrlProblem('https://router.example.com', { ROUTING_ALLOW_PUBLIC_ENGINE: '0' })).not.toBeNull();
    expect(privateServiceUrlProblem('https://u:p@router.example.com', { ROUTING_ALLOW_PUBLIC_ENGINE: '1' })).toMatch(/credentials/);
  });
});
