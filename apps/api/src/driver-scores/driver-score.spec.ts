import { gradeOf, safetyScore } from '@veetracer/shared';

describe('safetyScore', () => {
  it('a clean drive scores 100 (A)', () => {
    expect(safetyScore({ km: 120, events: {}, idleSec: 600, engineSec: 3 * 3600, nightKm: 0 })).toEqual({ score: 100, grade: 'A', penalties: { events: 0, idle: 0, night: 0 } });
  });

  it('events cost points per 100 km, so short and long drives compare fairly', () => {
    // 2 overspeeds (3 each) + 1 phone use (4) in 100 km = 10 points.
    expect(safetyScore({ km: 100, events: { OVERSPEED: 2, DRIVER_PHONE: 1 }, idleSec: 0, engineSec: 3600, nightKm: 0 }).score).toBe(90);
    // The same events in 200 km cost half.
    expect(safetyScore({ km: 200, events: { OVERSPEED: 2, DRIVER_PHONE: 1 }, idleSec: 0, engineSec: 3600, nightKm: 0 }).score).toBe(95);
  });

  it('idling over 20 % and night driving over 30 % cost a little; too little driving is not scored', () => {
    const r = safetyScore({ km: 100, events: {}, idleSec: 0.45 * 3600, engineSec: 3600, nightKm: 60 });
    expect(r.penalties).toEqual({ events: 0, idle: 10, night: 5 });
    expect(r.score).toBe(85);
    expect(safetyScore({ km: 4, events: { OVERSPEED: 5 }, idleSec: 0, engineSec: 600, nightKm: 0 })).toMatchObject({ score: null, grade: null });
  });

  it('grades', () => {
    expect([95, 80, 65, 40].map(gradeOf)).toEqual(['A', 'B', 'C', 'D']);
  });
});
