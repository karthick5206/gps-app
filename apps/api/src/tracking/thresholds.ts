import { DEFAULT_THRESHOLDS, StatusThresholds } from '@veetracer/shared';

type ThresholdKey = keyof StatusThresholds;
const KEYS = Object.keys(DEFAULT_THRESHOLDS) as ThresholdKey[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thresholds from `Company.settings.thresholds`, falling back to defaults per field. */
export function companyThresholds(settings: unknown): StatusThresholds {
  const raw = isRecord(settings) && isRecord(settings.thresholds) ? settings.thresholds : {};
  const result = { ...DEFAULT_THRESHOLDS };
  for (const key of KEYS) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}
