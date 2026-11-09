/** Scheduled-report options payload (D-2). Pure; the option keys per type come from shared REPORT_OPTION_KEYS. */
import type { ReportOptions, ScheduleReportOptions } from '@veetracer/shared';

type Keys = Partial<Record<string, readonly (keyof ReportOptions)[]>>;

/**
 * Options to save with a schedule: only the selected report types, only the options each accepts, only values the
 * user set (empty = the report's default, exactly like an on-screen run with the field left empty).
 */
export function scheduleOptionsPayload(types: readonly string[], options: ScheduleReportOptions, keys: Keys): ScheduleReportOptions {
  const out: Record<string, ReportOptions> = {};
  for (const type of types) {
    const allowed = keys[type];
    const src = (options as Record<string, ReportOptions | undefined>)[type];
    if (!allowed || !src) continue;
    const picked: Record<string, unknown> = {};
    for (const k of allowed) {
      const v = src[k];
      if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
      picked[k] = v;
    }
    if (Object.keys(picked).length) out[type] = picked as ReportOptions;
  }
  return out as ScheduleReportOptions;
}

/** Schedule dialog defaults built from an on-screen report run ("Schedule this"). */
export function prefillFromRun(run: { type: string; scope: { branchIds: string[]; groupIds: string[]; objectIds: string[] }; period?: 'DAY' | 'WEEK' | 'MONTH'; options?: ReportOptions }, label: string, keys: Keys) {
  return {
    name: label,
    reportTypes: [run.type],
    scope: run.scope,
    period: run.period ?? 'DAY',
    options: scheduleOptionsPayload([run.type], run.options ? { [run.type]: run.options } : {}, keys),
  };
}
