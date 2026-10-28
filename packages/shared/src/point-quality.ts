/**
 * Point quality analysis (History → All points): every recorded point with a verdict, and the cleaned track.
 * Labels are indexes into POINT_LABELS (compact JSON); reasons are shown in the legend and the hover.
 */
export const POINT_LABELS = ['good', 'drift', 'spike', 'jump', 'inaccurate', 'mock', 'invalid', 'duplicate'] as const;
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
}

export interface PointQualitySettingsDto {
  enabled: boolean;
}
