import type { ReportPeriod } from '@veetracer/shared';

/** Row grouping for the Summary, Distance and Engine hours reports. */
export const PERIOD_OPTIONS: { value: ReportPeriod; label: string }[] = [
  { value: 'DAY', label: 'Daily' },
  { value: 'WEEK', label: 'Weekly (Mon–Sun)' },
  { value: 'MONTH', label: 'Monthly' },
];
