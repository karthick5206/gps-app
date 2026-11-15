/** Billable distance resolution (doc 19 §5.4): never 0 km, never arbitrary. */
import type { DistanceInput, DistanceResolution, DistanceSource, GpsQuality } from './types';

const km = (m: number) => `${(m / 1000).toFixed(3)} km`;
const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function gpsQualityOf(input: DistanceInput): GpsQuality {
  if (!has(input.gpsM)) return 'MISSING';
  if (has(input.offlineGapS) && has(input.maxOfflineGapS) && input.offlineGapS > input.maxOfflineGapS) return 'LOW_COVERAGE';
  if (has(input.plannedM) && input.plannedM > 0) {
    const min = input.gpsMinPctOfPlanned ?? 50;
    const max = input.gpsMaxPctOfPlanned ?? 200;
    // Integer comparison: gps × 100 vs planned × pct.
    if (input.gpsM * 100 < input.plannedM * min || input.gpsM * 100 > input.plannedM * max) return 'LOW_COVERAGE';
  }
  return 'OK';
}

const VALUE: Record<DistanceSource, keyof DistanceInput> = { GPS: 'gpsM', PLANNED: 'plannedM', AGREED: 'agreedM', MANUAL_APPROVED: 'manualM' };
const NAME: Record<DistanceSource, string> = { GPS: 'GPS', PLANNED: 'planned', AGREED: 'agreed', MANUAL_APPROVED: 'manual (approved)' };

export function resolveBillableDistance(input: DistanceInput): DistanceResolution {
  const gpsQuality = gpsQualityOf(input);
  const valueOf = (s: DistanceSource) => input[VALUE[s]] as number | null | undefined;
  // A dispatcher-approved manual value always wins when present (it is the explicit correction).
  if (has(input.manualM)) return { billableM: input.manualM, usedSource: 'MANUAL_APPROVED', gpsQuality, needsReview: false, basis: `manual distance ${km(input.manualM)} (approved)` };
  if (input.source === 'GPS') {
    if (gpsQuality === 'OK') return { billableM: input.gpsM!, usedSource: 'GPS', gpsQuality, needsReview: false, basis: `GPS distance ${km(input.gpsM!)}` };
    const why = gpsQuality === 'MISSING' ? 'GPS distance missing' : 'GPS coverage low';
    if (input.onMissingGps === 'REVIEW') return { billableM: null, usedSource: null, gpsQuality, needsReview: true, basis: `${why}: needs review (contract policy REVIEW)` };
    const fb: DistanceSource = input.onMissingGps === 'USE_PLANNED' ? 'PLANNED' : 'AGREED';
    const v = valueOf(fb);
    if (has(v) && v > 0) return { billableM: v, usedSource: fb, gpsQuality, needsReview: false, basis: `${why}: ${NAME[fb]} distance ${km(v)} used (contract policy ${input.onMissingGps})` };
    return { billableM: null, usedSource: null, gpsQuality, needsReview: true, basis: `${why} and no ${NAME[fb]} distance: needs review` };
  }
  const v = valueOf(input.source);
  if (has(v) && (v > 0 || input.source === 'MANUAL_APPROVED')) return { billableM: v, usedSource: input.source, gpsQuality, needsReview: false, basis: `${NAME[input.source]} distance ${km(v)}` };
  return { billableM: null, usedSource: null, gpsQuality, needsReview: true, basis: `no ${NAME[input.source]} distance: needs review` };
}
