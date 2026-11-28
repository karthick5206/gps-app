import { BadRequestException } from '@nestjs/common';
import type { ReportRequest } from '@veetracer/shared';
import { ReportDataService, reportWindow } from './report-data.service';
import { periodText } from './report-summary';

const TZ = 'Asia/Kolkata';
const req = (r: Partial<ReportRequest>): ReportRequest => ({ type: 'TRIPS', scope: { branchIds: [], groupIds: [], objectIds: [] }, from: '2026-11-28', to: '2026-11-28', ...r });

describe('report time window', () => {
  it('whole days without times', () => {
    const w = reportWindow(req({ from: '2026-11-27' }), TZ);
    expect(new Date(w.gte).toISOString()).toBe('2026-11-26T18:30:00.000Z');
    expect(new Date(w.lt).toISOString()).toBe('2026-11-28T18:30:00.000Z');
    expect(w.timed).toBe(false);
  });

  it('timed report: 11:00 to 12:30 local, end minute inclusive', () => {
    const w = reportWindow(req({ fromTime: '11:00', toTime: '12:30' }), TZ);
    expect(new Date(w.gte).toISOString()).toBe('2026-11-28T05:30:00.000Z');
    expect(new Date(w.lt).toISOString()).toBe('2026-11-28T07:01:00.000Z');
    expect(w).toMatchObject({ timed: true, fromTime: '11:00', toTime: '12:30' });
  });

  it('only one time given: the other end stays at the day edge', () => {
    const w = reportWindow(req({ from: '2026-11-27', fromTime: '20:00' }), TZ);
    expect(new Date(w.gte).toISOString()).toBe('2026-11-27T14:30:00.000Z');
    expect(new Date(w.lt).toISOString()).toBe('2026-11-28T18:30:00.000Z');
    expect(w.toTime).toBe('23:59');
  });

  it('day-based reports ignore the times', () => {
    const w = reportWindow(req({ type: 'SUMMARY', fromTime: '11:00', toTime: '12:30' }), TZ);
    expect(w.timed).toBe(false);
    expect(new Date(w.gte).toISOString()).toBe('2026-11-27T18:30:00.000Z');
  });

  it('same day with the end before the start is refused', () => {
    const svc = new ReportDataService({} as never, {} as never);
    expect(() => svc.validate(req({ fromTime: '12:00', toTime: '11:00' }))).toThrow(BadRequestException);
    expect(() => svc.validate(req({ from: '2026-11-27', fromTime: '12:00', toTime: '11:00' }))).not.toThrow();
  });

  it('period text shows the times', () => {
    expect(periodText({ from: '2026-11-28', to: '2026-11-28', fromTime: '11:00', toTime: '12:30' })).toBe('2026-11-28 11:00 to 12:30');
    expect(periodText({ from: '2026-11-27', to: '2026-11-28', fromTime: '20:00', toTime: '08:00' })).toBe('2026-11-27 20:00 to 2026-11-28 08:00');
    expect(periodText({ from: '2026-11-27', to: '2026-11-28' })).toBe('2026-11-27 to 2026-11-28');
  });
});
