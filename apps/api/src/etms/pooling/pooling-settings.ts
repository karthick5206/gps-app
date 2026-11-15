import { DEFAULT_POOLING_SETTINGS, LIVE_DISPATCH_POLICIES, type DriverHoursPolicy, type LiveDispatchPolicy, type PoolingSettingsDto } from '@veetracer/shared';

/** Key of Company.settings holding the pooling / live-dispatch settings (kept apart from `etms` on purpose). */
export const POOLING_SETTINGS_KEY = 'etmsPooling';

const num = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** Company.settings.etmsPooling.driverHours → policy (null = none, P7). */
export function driverHoursOf(raw: unknown): DriverHoursPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const p: DriverHoursPolicy = {
    maxDutyS: num(r.maxDutyS, 3600, 86_400),
    maxDrivingS: num(r.maxDrivingS, 1800, 86_400),
    breakAfterS: num(r.breakAfterS, 1800, 43_200),
    breakS: num(r.breakS, 300, 14_400),
    minRestS: num(r.minRestS, 3600, 86_400),
  };
  return Object.values(p).some((v) => v !== null) ? p : null;
}

/** The server's environment kill switch: ETMS_LIVE_DISPATCH=off (any case) switches live dispatch off everywhere. */
export function liveDispatchKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ETMS_LIVE_DISPATCH ?? '').trim().toLowerCase() === 'off';
}

/** Reads Company.settings.etmsPooling (anything missing / malformed = the defaults: live dispatch OFF). */
export function poolingSettingsOf(settings: unknown, env: NodeJS.ProcessEnv = process.env): PoolingSettingsDto {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>)[POOLING_SETTINGS_KEY] : undefined;
  const p = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  const policy = (v: unknown, d: LiveDispatchPolicy): LiveDispatchPolicy => ((LIVE_DISPATCH_POLICIES as readonly unknown[]).includes(v) ? (v as LiveDispatchPolicy) : d);
  return {
    liveDispatch: p.liveDispatch === true,
    scheduledPolicy: policy(p.scheduledPolicy, DEFAULT_POOLING_SETTINGS.scheduledPolicy),
    delayPolicy: policy(p.delayPolicy, DEFAULT_POOLING_SETTINGS.delayPolicy),
    delayThresholdS: num(p.delayThresholdS, 60, 7200) ?? DEFAULT_POOLING_SETTINGS.delayThresholdS,
    driverHours: driverHoursOf(p.driverHours),
    killSwitch: liveDispatchKilled(env),
  };
}

/** Live dispatch runs for a company only with its own switch on AND the environment kill switch not set. */
export function liveDispatchOn(s: PoolingSettingsDto): boolean {
  return s.liveDispatch && !s.killSwitch;
}
