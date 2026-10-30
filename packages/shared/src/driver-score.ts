/**
 * Driver scorecard: a 0–100 safety score per driver (or per vehicle when nobody is assigned) for a period, from the
 * driving behaviour alerts the trackers / dashcams raise and the day summaries. Penalties are per 100 km driven so short
 * and long distances compare fairly; idling and night driving cost a little on top.
 */

export const SCORE_MIN_KM = 10;

/** Alert types that count against the driver, and their weight (points per event per 100 km). */
export const SCORE_WEIGHTS: Record<string, number> = {
  OVERSPEED: 3,
  GEOFENCE_OVERSPEED: 3,
  HARSH_ACCELERATION: 2,
  HARSH_BRAKING: 2,
  HARSH_CORNERING: 2,
  DRIVER_PHONE: 4,
  DRIVER_SMOKING: 3,
  DRIVER_DISTRACTED: 4,
  DRIVER_FATIGUE: 5,
  DRIVER_ABSENT: 2,
  FORWARD_COLLISION_WARNING: 3,
  LANE_DEPARTURE: 1,
  TAILGATING: 2,
  CRASH: 20,
};

/** Columns of the scorecard (in this order), grouping the alert types. */
export const SCORE_GROUPS = {
  overspeed: ['OVERSPEED', 'GEOFENCE_OVERSPEED'],
  harsh: ['HARSH_ACCELERATION', 'HARSH_BRAKING', 'HARSH_CORNERING'],
  dms: ['DRIVER_PHONE', 'DRIVER_SMOKING', 'DRIVER_DISTRACTED', 'DRIVER_FATIGUE', 'DRIVER_ABSENT'],
  adas: ['FORWARD_COLLISION_WARNING', 'LANE_DEPARTURE', 'TAILGATING'],
  crash: ['CRASH'],
} as const;

export type ScoreGrade = 'A' | 'B' | 'C' | 'D';

export interface ScoreInput {
  km: number;
  /** Alert counts by type. */
  events: Record<string, number>;
  idleSec: number;
  engineSec: number;
  nightKm: number;
}

export interface ScoreResult {
  /** Null when there was too little driving (under SCORE_MIN_KM) to score fairly. */
  score: number | null;
  grade: ScoreGrade | null;
  /** Points taken off per reason (for the breakdown). */
  penalties: { events: number; idle: number; night: number };
}

export const gradeOf = (score: number): ScoreGrade => (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D');

export function safetyScore(i: ScoreInput): ScoreResult {
  if (i.km < SCORE_MIN_KM) return { score: null, grade: null, penalties: { events: 0, idle: 0, night: 0 } };
  const per100 = 100 / i.km;
  let events = 0;
  for (const [type, n] of Object.entries(i.events)) events += (SCORE_WEIGHTS[type] ?? 0) * n * per100;
  // Idling over 20 % of engine time: up to 10 points.
  const idleShare = i.engineSec > 0 ? i.idleSec / i.engineSec : 0;
  const idle = Math.min(10, Math.max(0, (idleShare - 0.2) * 40));
  // Driving between 22:00 and 05:00 over 30 % of the distance: up to 5 points.
  const nightShare = i.nightKm / i.km;
  const night = Math.min(5, Math.max(0, (nightShare - 0.3) * 20));
  const score = Math.max(0, Math.round(100 - events - idle - night));
  return { score, grade: gradeOf(score), penalties: { events: Math.round(events * 10) / 10, idle: Math.round(idle * 10) / 10, night: Math.round(night * 10) / 10 } };
}

export type ScorePeriod = 'week' | 'lastWeek' | 'month' | 'lastMonth';
export type ScoreBy = 'driver' | 'vehicle';

export interface DriverScoreRow {
  /** Driver id, or the vehicle id when scoring by vehicle / for vehicles without a driver. */
  id: string;
  kind: ScoreBy;
  name: string;
  /** Vehicles driven (driver rows) or the plate (vehicle rows). */
  detail: string | null;
  km: number;
  score: number | null;
  grade: ScoreGrade | null;
  overspeed: number;
  harsh: number;
  dms: number;
  adas: number;
  crash: number;
  idlePct: number;
  nightKm: number;
  penalties: ScoreResult['penalties'];
}

export interface DriverScoresDto {
  period: ScorePeriod;
  by: ScoreBy;
  from: string;
  to: string;
  rows: DriverScoreRow[];
  /** Fleet average of scored rows. */
  average: number | null;
}
