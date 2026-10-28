/**
 * Point quality analysis (History → All points): every recorded point with a verdict, and the cleaned track.
 * Labels are indexes into POINT_LABELS (compact JSON); reasons are shown in the legend and the hover.
 */
// New labels go at the end: the index is what the API sends.
export const POINT_LABELS = ['good', 'drift', 'spike', 'jump', 'inaccurate', 'mock', 'invalid', 'duplicate', 'offroad'] as const;

/** Labels whose points are left out of trips and distance when PointQualitySettings.useInReports is on (Position flag OUTLIER). */
export const OUTLIER_LABELS: readonly PointLabel[] = ['spike', 'jump', 'inaccurate', 'mock', 'invalid'];
export type PointLabel = (typeof POINT_LABELS)[number];

/** Where a point came from: the stored position, or (phones) the raw record the server keeps for 7 days. */
export const POINT_SOURCES = ['stored', 'raw'] as const;

/** [epochMs, lat, lng, accuracyM (-1 = unknown), speedKph, label index, source index] */
export type QualityPoint = [number, number, number, number, number, number, number];

export interface PointQualityResponse {
  objectId: string;
  from: string;
  to: string;
  points: QualityPoint[];
  /** Cleaned track: smoothed moving parts, each stop as one spot (its start and end time). [epochMs, lat, lng] */
  clean: [number, number, number][];
  /** Number of points per label. */
  counts: Record<PointLabel, number>;
  /** True when the range had more points than the cap (the newest were dropped). */
  truncated: boolean;
  /** True when the moving parts were snapped to roads (the clean track follows them; off-road points are labelled). */
  roadMatched: boolean;
  /** Distance of the recorded points vs the clean track, in km. */
  distanceKm: { recorded: number; clean: number };
}

export interface PointQualitySettingsDto {
  enabled: boolean;
  /** Trips, daily distance and the History track leave out spikes, jumps, inaccurate, fake and invalid points. */
  useInReports: boolean;
}
