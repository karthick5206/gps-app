import { parseQuery, searchKey } from '@veetracer/shared';

const q = (s: string) => parseQuery(s, 2026);

describe('parseQuery', () => {
  it('reads "where is" with a plate', () => {
    expect(q('Where is TN 09 BB 9421?')).toEqual({ intent: 'WHERE', vehicle: 'tn 09 bb 9421', time: null });
  });

  it('reads a time yesterday', () => {
    expect(q('where was tn09bb9421 yesterday at 3 pm')).toEqual({ intent: 'WHERE', vehicle: 'tn09bb9421', time: { kind: 'day', offset: -1, atMin: 15 * 60 } });
    expect(q('TN09 at 15:30 yesterday').time).toEqual({ kind: 'day', offset: -1, atMin: 15 * 60 + 30 });
  });

  it('reads distance this week, a date and last N days', () => {
    expect(q('km TN 09 BB 9421 this week')).toEqual({ intent: 'DISTANCE', vehicle: 'tn 09 bb 9421', time: { kind: 'week', offset: 0 } });
    expect(q('distance 9421 on 30 oct').time).toEqual({ kind: 'date', day: '2026-10-30' });
    expect(q('how many km last 5 days')).toEqual({ intent: 'DISTANCE', vehicle: '', time: { kind: 'lastDays', days: 5 } });
  });

  it('reads fleet questions without a vehicle', () => {
    expect(q('which vehicle idled most this week')).toEqual({ intent: 'IDLE', vehicle: '', time: { kind: 'week', offset: 0 } });
    expect(q('overspeed today')).toEqual({ intent: 'OVERSPEED', vehicle: '', time: { kind: 'day', offset: 0 } });
    expect(q('offline vehicles').intent).toBe('OFFLINE');
    expect(q('moved last night')).toEqual({ intent: 'NIGHT', vehicle: '', time: { kind: 'lastNight' } });
    expect(q('documents due')).toMatchObject({ intent: 'DOCUMENTS', vehicle: '' });
    expect(q('battery low')).toMatchObject({ intent: 'BATTERY', vehicle: '' });
    expect(q('charging now').intent).toBe('CHARGING');
  });

  it('keeps names that contain keyword letters intact', () => {
    expect(q('where is parthan').vehicle).toBe('parthan');
    expect(q('trips kannagi yesterday')).toEqual({ intent: 'TRIPS', vehicle: 'kannagi', time: { kind: 'day', offset: -1 } });
  });

  it('a bare vehicle is a status question', () => {
    expect(q('TN 22 BJ 9784')).toEqual({ intent: 'STATUS', vehicle: 'tn 22 bj 9784', time: null });
  });

  it('understands Tamil and Hindi keywords', () => {
    expect(q('TN09 எங்கே')).toMatchObject({ intent: 'WHERE', vehicle: 'tn09' });
    expect(q('நேற்று கிமீ TN09')).toMatchObject({ intent: 'DISTANCE', time: { kind: 'day', offset: -1 } });
    expect(q('आज ओवरस्पीड')).toMatchObject({ intent: 'OVERSPEED', time: { kind: 'day', offset: 0 } });
  });

  it('makes plate keys', () => {
    expect(searchKey('TN 09-BB 9421')).toBe('tn09bb9421');
  });
});
