import { PlannedTripStatus } from '@veetracer/shared';
import { canCancelTrip, canCompleteTrip, canEditTrip, canStartTrip, isNotStarted, isTimedOut } from './trip-rules';

const MIN = 60_000;
const now = Date.parse('2026-11-10T10:00:00.000Z');

describe('status rules', () => {
  it('edit and start only while SCHEDULED', () => {
    expect(canEditTrip('SCHEDULED')).toBe(true);
    expect(canEditTrip('STARTED')).toBe(false);
    expect(canStartTrip('SCHEDULED')).toBe(true);
    expect(canStartTrip('IN_PROGRESS')).toBe(false);
  });

  it('cancel while SCHEDULED / STARTED / IN_PROGRESS', () => {
    expect((['SCHEDULED', 'STARTED', 'IN_PROGRESS'] as PlannedTripStatus[]).every(canCancelTrip)).toBe(true);
    expect((['COMPLETED', 'INCOMPLETE', 'CANCELLED'] as PlannedTripStatus[]).some(canCancelTrip)).toBe(false);
  });

  it('complete while STARTED / IN_PROGRESS', () => {
    expect(canCompleteTrip('STARTED')).toBe(true);
    expect(canCompleteTrip('IN_PROGRESS')).toBe(true);
    expect(canCompleteTrip('SCHEDULED')).toBe(false);
  });
});

describe('isTimedOut', () => {
  it('times out open trips 120 min after the planned end', () => {
    expect(isTimedOut({ status: 'IN_PROGRESS', plannedEnd: new Date(now - 121 * MIN) }, now)).toBe(true);
    expect(isTimedOut({ status: 'IN_PROGRESS', plannedEnd: new Date(now - 119 * MIN) }, now)).toBe(false);
    expect(isTimedOut({ status: 'SCHEDULED', plannedEnd: new Date(now - 121 * MIN) }, now)).toBe(true);
    expect(isTimedOut({ status: 'COMPLETED', plannedEnd: new Date(now - 500 * MIN) }, now)).toBe(false);
  });
});

describe('isNotStarted', () => {
  const trip = (startAgoMin: number, endInMin: number, status: PlannedTripStatus = 'SCHEDULED') => ({
    status,
    plannedStart: new Date(now - startAgoMin * MIN),
    plannedEnd: new Date(now + endInMin * MIN),
  });

  it('flags a SCHEDULED trip 30 min after its planned start', () => {
    expect(isNotStarted(trip(30, 60), now)).toBe(true);
    expect(isNotStarted(trip(29, 60), now)).toBe(false);
  });

  it('does not flag a trip that is already timed out or not SCHEDULED', () => {
    expect(isNotStarted(trip(300, -121), now)).toBe(false);
    expect(isNotStarted(trip(60, 60, 'STARTED'), now)).toBe(false);
  });
});
