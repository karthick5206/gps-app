import { JobError } from '../routing-jobs/job-worker';
import { GraphHopperProvider } from './provider/graphhopper.provider';
import { readRouterConfig } from './provider/router-config';
import { scrubCoordinates, transportErrorText } from './engine-text';

/** E4 security review L4: engine text with coordinates never reaches a job error, an API answer or a log. */
describe('engine text (L4)', () => {
  it('scrubCoordinates removes coordinate pairs and fine decimals, keeps ordinary text', () => {
    expect(scrubCoordinates('Point 1 is too far from Point 2: 13.0812,80.2654')).toBe('Point 1 is too far from Point 2: [point]');
    expect(scrubCoordinates('between 13.0812, 80.2654 and -33.86;151.21')).toBe('between [point] and [point]');
    expect(scrubCoordinates('lat 13.081234 lng 80.265401')).not.toMatch(/13\.08|80\.26/);
    expect(scrubCoordinates('Stopped after 5 routing-engine failures in a row: GraphHopper returned HTTP 503')).toBe('Stopped after 5 routing-engine failures in a row: GraphHopper returned HTTP 503');
    expect(scrubCoordinates('limit 120 s, 500 stops')).toBe('limit 120 s, 500 stops');
  });

  it('transportErrorText keeps the class and system code only', () => {
    expect(transportErrorText(Object.assign(new TypeError('fetch failed http://x/route?point=13.08,80.26'), { cause: { code: 'ECONNREFUSED' } }))).toBe('TypeError ECONNREFUSED');
    expect(transportErrorText(new Error('13.0812,80.2654'))).toBe('Error');
    expect(transportErrorText('boom')).toBe('Error');
  });

  it('JobError messages (RoutingJob.error, GET /routing/jobs/:id) are scrubbed', () => {
    const e = new JobError('ENGINE_UNREACHABLE', 'Road matrix unavailable: Point 1 is too far from Point 2: 13.0812,80.2654');
    expect(e.message).toBe('Road matrix unavailable: Point 1 is too far from Point 2: [point]');
  });

  describe('GraphHopperProvider answers', () => {
    const env = { ...process.env };
    afterEach(() => {
      process.env = { ...env };
      jest.restoreAllMocks();
    });
    const provider = () => new GraphHopperProvider(readRouterConfig({ ROUTER_URL: 'http://127.0.0.1:8989', ROUTER_ENGINE: 'graphhopper' }));
    const A = { lat: 13.0812, lng: 80.2654 };
    const B = { lat: 13.0604, lng: 80.2496 };

    it.each([
      [400, 'Cannot find point 0: 13.0812,80.2654', 'POINT_NOT_ON_ROAD'],
      [400, 'Point 1 is too far from Point 2: 13.0812,80.2654', 'NO_ROUTE'],
      [500, 'Internal error near 13.0812,80.2654', 'ENGINE_UNREACHABLE'],
    ])('HTTP %s "%s" → %s with fixed text', async (status, message, degraded) => {
      const warn = jest.spyOn((provider() as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } }));
      const r = await provider().route(A, B);
      expect(r).toMatchObject({ ok: false, degraded });
      expect(JSON.stringify(r)).not.toMatch(/13\.08|80\.26/);
      warn.mockRestore();
    });

    it('a thrown fetch error (its text may hold the URL with the points) is reduced to its class / code', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        throw Object.assign(new TypeError('fetch failed: http://127.0.0.1:8989/route?point=13.0812,80.2654'), { cause: { code: 'ECONNRESET' } });
      });
      const r = await provider().route(A, B);
      expect(r).toMatchObject({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'GraphHopper unreachable (TypeError ECONNRESET)' });
    });
  });
});
