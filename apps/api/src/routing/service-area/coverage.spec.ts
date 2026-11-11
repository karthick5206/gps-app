import { COASTAL_TOLERANCE_M, coverageIssue, coverageUnavailable, distanceToIndiaBoundaryM, inIndia, parseBbox } from './coverage';

/** Ported from the routing branch's access.spec.ts "coverage polygon (R1)", plus the provider mapping. */
describe('India coverage polygon', () => {
  const cases: [string, number, number, boolean][] = [
    ['Chennai Central', 13.0827, 80.2757, true],
    ['Marina beach (coast)', 13.05, 80.2824, true],
    ['Kanyakumari', 8.0883, 77.5385, true],
    ['Leh', 34.1526, 77.5771, true],
    ['Port Blair', 11.6234, 92.7265, true],
    ['Kavaratti (Lakshadweep)', 10.5669, 72.642, true],
    ['Bay of Bengal', 12.5, 82.0, false],
    ['Colombo', 6.9271, 79.8612, false],
    ['Kathmandu', 27.7172, 85.324, false],
    ['Dhaka', 23.8103, 90.4125, false],
    ['Lahore', 31.5204, 74.3587, false],
    ['Swapped Chennai (lat / lng mix-up)', 80.27, 13.08, false],
  ];
  it.each(cases)('%s', (_n, lat, lng, expected) => {
    expect(inIndia({ lat, lng })).toBe(expected);
  });

  it('coastal tolerance', () => {
    expect(distanceToIndiaBoundaryM({ lat: 12.5, lng: 82 })).toBeGreaterThan(COASTAL_TOLERANCE_M);
    expect(distanceToIndiaBoundaryM({ lat: 13.05, lng: 80.2824 })).toBeLessThan(COASTAL_TOLERANCE_M);
  });

  it('graph extent: inside India but outside the graph', () => {
    expect(coverageIssue({ lat: 28.6315, lng: 77.2167 }, [76, 8, 80.5, 13.6])).toBe('OUTSIDE_GRAPH');
    expect(coverageIssue({ lat: 13.0827, lng: 80.2757 }, [76, 8, 80.5, 13.6])).toBeNull();
    expect(coverageIssue({ lat: 13.0827, lng: 80.2757 }, null)).toBeNull();
    expect(coverageIssue({ lat: 51.5, lng: -0.12 }, null)).toBe('OUTSIDE_INDIA');
  });

  it('parses ROUTING_GRAPH_BBOX strictly', () => {
    expect(parseBbox('76,8,80.5,13.6')).toEqual([76, 8, 80.5, 13.6]);
    expect(parseBbox(undefined)).toBeNull();
    expect(parseBbox('')).toBeNull();
    expect(parseBbox('76,8,80.5')).toBeNull();
    expect(parseBbox('80.5,8,76,13.6')).toBeNull();
    expect(parseBbox('a,b,c,d')).toBeNull();
  });

  it('becomes the provider OUTSIDE_COVERAGE result (no numbers)', () => {
    expect(coverageUnavailable({ lat: 13.0827, lng: 80.2757 }, null)).toBeNull();
    expect(coverageUnavailable({ lat: 6.9271, lng: 79.8612 }, null)).toEqual({ ok: false, degraded: 'OUTSIDE_COVERAGE', message: 'The point is outside India' });
    expect(coverageUnavailable({ lat: 28.6315, lng: 77.2167 }, [76, 8, 80.5, 13.6])).toMatchObject({ degraded: 'OUTSIDE_COVERAGE', message: 'The point is outside the routing graph' });
  });
});
