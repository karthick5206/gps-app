import { BadRequestException } from '@nestjs/common';
import { REPORT_OPTION_KEYS, ReportOptions, ReportType, ScheduleReportOptions } from '@veetracer/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReportOptionsDto } from '../reports/reports.dto';

/**
 * Validated report options for a schedule: only the schedule's report types, only the options each type accepts
 * (REPORT_OPTION_KEYS), each value checked with the same rules as an on-screen run (ReportOptionsDto). Types without
 * options left are omitted, so a schedule saved without options stays {} and runs with the defaults as before.
 */
export function normalizeScheduleOptions(raw: unknown, reportTypes: readonly string[]): ScheduleReportOptions {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('options must be an object keyed by report type');
  const out: ScheduleReportOptions = {};
  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!reportTypes.includes(type)) continue; // options of a report that is not (or no longer) in the schedule
    const keys = REPORT_OPTION_KEYS[type as ReportType];
    if (!keys || value === null || value === undefined) continue;
    if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`options.${type} must be an object`);
    const picked: Record<string, unknown> = {};
    for (const k of keys) if ((value as Record<string, unknown>)[k] !== undefined) picked[k] = (value as Record<string, unknown>)[k];
    const errors = validateSync(plainToInstance(ReportOptionsDto, picked), { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const first = errors[0];
      throw new BadRequestException(`options.${type}.${first.property}: ${Object.values(first.constraints ?? {})[0] ?? 'invalid'}`);
    }
    const clean = picked as ReportOptions;
    if (clean.alertTypes) clean.alertTypes = [...new Set(clean.alertTypes)];
    if (clean.alertTypes && !clean.alertTypes.length) delete clean.alertTypes;
    if (Object.keys(clean).length) out[type as ReportType] = clean;
  }
  return out;
}

/** Options to pass when generating `type` for a schedule; undefined (= API defaults, as before) when none are saved. */
export function scheduleRunOptions(stored: unknown, type: ReportType): ReportOptions | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const o = (stored as ScheduleReportOptions)[type];
  return o && Object.keys(o).length ? o : undefined;
}
