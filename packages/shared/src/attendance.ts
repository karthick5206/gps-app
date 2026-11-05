/**
 * Staff attendance: people tracked by phone / ID card check in and out automatically when they enter and leave a
 * work-site geofence. Shifts are set per company, branch or person (company time zone).
 */

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'NOT_ARRIVED' | 'ABSENT' | 'DAY_OFF' | 'UPCOMING';

/** Time outside the work site during the shift: not yet explained, approved as official duty, or marked personal. */
export type OutingKind = 'UNEXPLAINED' | 'OFFICIAL' | 'PERSONAL';
/** What a person's phone says right now (today only). */
export type AttendanceLiveState = 'INSIDE' | 'OUT' | 'NO_SIGNAL';
/** A manual correction of a day. */
export type AttendanceOverride = 'PRESENT' | 'HALF_DAY' | 'ABSENT' | 'DAY_OFF';
export const ATTENDANCE_OVERRIDES: AttendanceOverride[] = ['PRESENT', 'HALF_DAY', 'ABSENT', 'DAY_OFF'];

export interface AttendanceShiftDto {
  id: string;
  name: string;
  days: number[];
  startMin: number;
  endMin: number;
  /** Branches on this shift. */
  branchIds: string[];
  /** People on this shift whatever their branch (wins over branchIds). */
  objectIds: string[];
}

export interface AttendanceSettingsDto {
  enabled: boolean;
  /** Work-site geofences. A person counts at those of their own branch and those without a branch. */
  geofenceIds: string[];
  /** Staff (tracked objects) covered; empty = every person (phone / ID card) in the company. */
  objectIds: string[];
  /** Default shift: working days, 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Default shift: working hours, minutes after midnight. */
  startMin: number;
  endMin: number;
  /** Arriving within this many minutes after the start is still on time. Only Super Admin can change it. */
  graceMin: number;
  /** Shifts for particular branches or people; everyone else is on the default shift. */
  shifts: AttendanceShiftDto[];
  /** Outside for less than this counts as inside and raises no alert. */
  shortExitMin: number;
  /** No data from the phone for this long is "no signal" (not counted as worked). */
  noSignalMin: number;
  /** Worked at least this long = half day; less = absent. */
  halfDayMin: number;
  /** Worked at least this long = full day. */
  fullDayMin: number;
  /** Alert again when someone is still out after this long; 0 = never. */
  outReminderMin: number;
  /** People who may attend at any branch's work site. */
  anyBranchObjectIds: string[];
  /** Management's choice: staff are asked for a selfie when they check in. It never decides the status by itself. */
  selfieRequired: boolean;
}

export const DEFAULT_ATTENDANCE: AttendanceSettingsDto = {
  enabled: false,
  geofenceIds: [],
  objectIds: [],
  days: [1, 2, 3, 4, 5, 6],
  startMin: 9 * 60 + 30,
  endMin: 18 * 60 + 30,
  graceMin: 15,
  shifts: [],
  shortExitMin: 5,
  noSignalMin: 20,
  halfDayMin: 4 * 60,
  fullDayMin: 8 * 60,
  outReminderMin: 60,
  anyBranchObjectIds: [],
  selfieRequired: false,
};

/** Check-in selfies are personal data: they are kept this long, then deleted. */
export const ATTENDANCE_SELFIE_KEEP_DAYS = 90;

/** Where a phone was when it crossed the fence. */
export interface AttendanceFix {
  lat: number;
  lng: number;
  /** GPS accuracy radius in metres, when the phone reported it. */
  accuracyM: number | null;
}

export interface AttendanceOutingDto {
  /** ISO time; with the object it identifies the outing. */
  leftAt: string;
  /** null = not back yet. */
  returnedAt: string | null;
  minutes: number;
  kind: OutingKind;
  note: string | null;
  site: string | null;
  fix: AttendanceFix | null;
  /** What the employee answered in the Tracker app. */
  employeeKind?: OutingKind | null;
  employeeNote?: string | null;
  /** An admin decided: it no longer follows the employee's answer. */
  decidedByAdmin?: boolean;
}

export interface AttendanceRowDto {
  objectId: string;
  name: string;
  day: string;
  status: AttendanceStatus;
  /** Worked less than a full day. Separate from status: installed apps can't show a status they don't know. */
  halfDay: boolean;
  firstIn: string | null;
  lastOut: string | null;
  /** Time inside the work sites that day (minutes), short exits included and no-signal time left out. */
  onSiteMin: number;
  /** Inside + official duty. */
  workedMin: number;
  officialMin: number;
  personalMin: number;
  unexplainedMin: number;
  noSignalMin: number;
  site: string | null;
  /** Minutes after start + grace (late arrivals). */
  lateMin: number;
  /** Minutes before the shift end at the final exit. */
  earlyMin: number;
  /** Worked beyond the length of the shift. */
  overtimeMin: number;
  branch: string | null;
  shift: string;
  state: AttendanceLiveState | null;
  /** Already inside when the attendance window opened: the phone may have stayed at the site overnight. */
  carriedOver: boolean;
  inFix: AttendanceFix | null;
  outFix: AttendanceFix | null;
  outings: AttendanceOutingDto[];
  /** Corrected by hand. */
  corrected: boolean;
  correctionNote: string | null;
  /** When the check-in selfie was taken. */
  selfieAt?: string | null;
  /** Where the phone was then (selfies from before 2026-11-06 have none). */
  selfieFix?: AttendanceFix | null;
  /** A selfie was asked for and there is none. */
  selfieMissing?: boolean;
}

export interface AttendanceDayDto {
  day: string;
  enabled: boolean;
  workingDay: boolean;
  rows: AttendanceRowDto[];
  /** Half-day rows are counted in halfDays, not under their status. */
  counts: Record<AttendanceStatus, number>;
  halfDays: number;
}

/** What the Tracker app shows its employee (GET /tracker/v1/attendance). */
export interface PhoneAttendanceDto {
  /** Attendance covers this phone today. Everything else is empty when it doesn't. */
  enabled: boolean;
  firstIn: string | null;
  state: AttendanceLiveState | null;
  site: string | null;
  /** Today's time outside still waiting for an answer, latest first. */
  outings: { leftAt: string; returnedAt: string | null; minutes: number; site: string | null }[];
  /** Ask for the check-in selfie now. */
  selfieNeeded: boolean;
  selfieAt: string | null;
  /** Today's shift, minutes after midnight (company time). */
  shiftStartMin?: number;
  shiftEndMin?: number;
}

/** A notification the phone should show (in the answer to a position upload). The id says when it is a new one. */
export interface PhoneAttention {
  id: string;
  title: string;
  text: string;
}

/** Which notification, if any, today's state calls for. */
export function phoneAttention(a: PhoneAttendanceDto, day: string): PhoneAttention | null {
  if (!a.enabled) return null;
  if (a.selfieNeeded) return { id: `selfie:${day}`, title: 'Take your check-in selfie', text: 'Open VeeTrax Tracker to take it.' };
  const out = a.outings[0];
  if (!out) return null;
  return { id: `outing:${out.leftAt}`, title: `You left ${out.site ?? 'the work site'}`, text: 'Tap to say if it is official duty or personal.' };
}

export interface Visit {
  enter: number;
  /** null = still inside. */
  exit: number | null;
  site: string;
  enterFix?: AttendanceFix | null;
  exitFix?: AttendanceFix | null;
}

export interface TimeSpan {
  from: number;
  to: number;
}

/** One person's day: local midnight bounds, shift instants and the limits in force. */
export interface AttendanceWindow {
  workingDay: boolean;
  dayStart: number;
  dayEnd: number;
  start: number;
  grace: number;
  end: number;
  shortExitMin: number;
  halfDayMin: number;
  fullDayMin: number;
}

/** Fence time counts from this long before the shift until this long after it. */
export const ATTENDANCE_BEFORE_SHIFT_MIN = 3 * 60;
export const ATTENDANCE_AFTER_SHIFT_MIN = 6 * 60;

const MIN = 60_000;
const toMin = (ms: number) => Math.round(ms / MIN);
const total = (spans: TimeSpan[]) => spans.reduce((sum, x) => sum + (x.to - x.from), 0);

function overlap(a: TimeSpan[], b: TimeSpan[]): number {
  let ms = 0;
  for (const x of a) for (const y of b) ms += Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  return ms;
}

function merged(spans: TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = [];
  for (const x of [...spans].sort((p, q) => p.from - q.from)) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ ...x });
  }
  return out;
}

export interface OutingDecision {
  kind: OutingKind;
  note: string | null;
  employeeKind?: OutingKind | null;
  employeeNote?: string | null;
  decidedByAdmin?: boolean;
}

export interface AttendanceDayResult {
  status: AttendanceStatus;
  halfDay: boolean;
  firstIn: number | null;
  lastOut: number | null;
  onSiteMin: number;
  workedMin: number;
  officialMin: number;
  personalMin: number;
  unexplainedMin: number;
  noSignalMin: number;
  site: string | null;
  lateMin: number;
  earlyMin: number;
  overtimeMin: number;
  state: AttendanceLiveState | null;
  carriedOver: boolean;
  inFix: AttendanceFix | null;
  outFix: AttendanceFix | null;
  outings: ({ leftAt: number; returnedAt: number | null; minutes: number; kind: OutingKind; note: string | null; site: string | null; fix: AttendanceFix | null } & Pick<OutingDecision, 'employeeKind' | 'employeeNote' | 'decidedByAdmin'>)[];
}

/**
 * One person's day from their fence visits, the periods without phone data and the admin's outing decisions.
 *
 * Time between first in and last out is split into inside (short exits included), official duty, personal, unexplained
 * and no signal. No signal takes precedence over inside, personal and unexplained: nobody knows where the phone was.
 * Approved official duty stays official. Worked = inside + official.
 */
export function attendanceOf(
  visits: Visit[],
  w: AttendanceWindow,
  now: number,
  gaps: TimeSpan[] = [],
  decisions: ReadonlyMap<number, OutingDecision> = new Map(),
): AttendanceDayResult {
  const windowStart = Math.max(w.dayStart, w.start - ATTENDANCE_BEFORE_SHIFT_MIN * MIN);
  const windowEnd = Math.min(w.dayEnd, w.end + ATTENDANCE_AFTER_SHIFT_MIN * MIN);
  const until = Math.min(now, windowEnd);
  const inDay = visits
    .map((v) => ({ ...v, from: Math.max(v.enter, windowStart), to: Math.min(v.exit ?? until, windowEnd) }))
    .filter((v) => v.to > v.from)
    .sort((a, b) => a.from - b.from);

  // Visits that overlap or touch (neighbouring sites) are one stay.
  const stays: (typeof inDay)[number][] = [];
  for (const v of inDay) {
    const prev = stays[stays.length - 1];
    if (prev && v.from <= prev.to) {
      if (v.to > prev.to || v.exit === null) stays[stays.length - 1] = { ...prev, to: Math.max(prev.to, v.to), exit: v.exit, exitFix: v.exitFix };
    } else stays.push(v);
  }

  const first = stays[0];
  const last = stays[stays.length - 1];
  const open = !!last && last.exit === null;
  const firstIn = first?.from ?? null;
  // Still inside when the window closed (past midnight, say): that is no exit.
  const lastOut = last && !open && (last.exit as number) <= windowEnd ? last.to : null;
  const carriedOver = !!first && first.enter < windowStart;

  // Outings: only the part inside the shift counts; a final exit before the shift end stays open until the end.
  const outings: AttendanceDayResult['outings'] = [];
  const counted: { span: TimeSpan; kind: OutingKind }[] = [];
  const insideSpans: TimeSpan[] = stays.map((v) => ({ from: v.from, to: v.to }));
  const addOuting = (stay: (typeof inDay)[number], returnedAt: number | null) => {
    const leftAt = stay.to;
    const outUntil = returnedAt ?? Math.min(now, w.end);
    if (outUntil - leftAt < w.shortExitMin * MIN) {
      if (returnedAt !== null) insideSpans.push({ from: leftAt, to: returnedAt }); // short exit: counts as inside
      return;
    }
    const span = { from: Math.max(leftAt, w.start), to: Math.min(outUntil, w.end) };
    if (span.to <= span.from) return; // entirely outside the shift
    const decision = decisions.get(leftAt);
    const kind = decision?.kind ?? 'UNEXPLAINED';
    counted.push({ span, kind });
    outings.push({ leftAt, returnedAt, minutes: toMin(span.to - span.from), kind, note: decision?.note ?? null, site: stay.site || null, fix: stay.exitFix ?? null, employeeKind: decision?.employeeKind ?? null, employeeNote: decision?.employeeNote ?? null, decidedByAdmin: decision?.decidedByAdmin ?? false });
  };
  stays.forEach((v, i) => {
    const next = stays[i + 1];
    if (next) addOuting(v, next.from);
    else if (!open) addOuting(v, null);
  });

  const inside = merged(insideSpans);
  const of = (kind: OutingKind) => counted.filter((c) => c.kind === kind).map((c) => c.span);
  const official = of('OFFICIAL');
  const personal = of('PERSONAL');
  const unexplained = of('UNEXPLAINED');
  const spanEnd = Math.max(last?.to ?? 0, ...counted.map((c) => c.span.to));
  const noSignal = firstIn === null ? [] : merged(gaps.map((g) => ({ from: Math.max(g.from, firstIn), to: Math.min(g.to, spanEnd) })).filter((g) => g.to > g.from));

  const onSiteMin = toMin(total(inside) - overlap(inside, noSignal));
  const officialMin = toMin(total(official));
  const personalMin = toMin(total(personal) - overlap(personal, noSignal));
  const unexplainedMin = toMin(total(unexplained) - overlap(unexplained, noSignal));
  const noSignalMin = toMin(total(noSignal) - overlap(noSignal, official));
  const workedMin = onSiteMin + officialMin;

  const finished = now >= w.end;
  const running = now < windowEnd;
  const silent = open && gaps.some((g) => g.from <= until && g.to >= until);
  const state: AttendanceLiveState | null = !running || firstIn === null ? null : silent ? 'NO_SIGNAL' : open ? 'INSIDE' : now < w.end ? 'OUT' : null;
  const finalOuting = outings.length && outings[outings.length - 1].returnedAt === null ? outings[outings.length - 1] : null;
  const earlyMin = finished && lastOut !== null && lastOut < w.end && finalOuting?.kind !== 'OFFICIAL' ? toMin(w.end - lastOut) : 0;
  const overtimeMin = finished ? Math.max(0, workedMin - toMin(w.end - w.start)) : 0;
  const lateMin = firstIn !== null && firstIn > w.grace ? toMin(firstIn - w.grace) : 0;
  const base = {
    firstIn,
    lastOut,
    onSiteMin,
    workedMin,
    officialMin,
    personalMin,
    unexplainedMin,
    noSignalMin,
    site: first?.site ?? null,
    earlyMin,
    overtimeMin,
    state,
    carriedOver,
    inFix: carriedOver ? null : (first?.enterFix ?? null),
    outFix: open ? null : (last?.exitFix ?? null),
    outings,
  };
  if (!w.workingDay) return { ...base, status: 'DAY_OFF', halfDay: false, lateMin: 0, earlyMin: 0, overtimeMin: 0 };
  if (firstIn === null) {
    const status: AttendanceStatus = now < w.grace ? 'UPCOMING' : now < w.end ? 'NOT_ARRIVED' : 'ABSENT';
    return { ...base, status, halfDay: false, lateMin: 0 };
  }
  const arrived: AttendanceStatus = lateMin > 0 ? 'LATE' : 'PRESENT';
  if (!finished) return { ...base, status: arrived, halfDay: false, lateMin };
  // A shift shorter than the limits can still be a full day.
  const fullNeed = Math.min(w.fullDayMin, toMin(w.end - w.start));
  const halfNeed = Math.min(w.halfDayMin, fullNeed);
  if (workedMin < halfNeed) return { ...base, status: 'ABSENT', halfDay: false, lateMin };
  return { ...base, status: arrived, halfDay: workedMin < fullNeed, lateMin };
}

/** Periods without phone data within [from, to], from the time of the first and last data and the long pauses between. */
export function signalGaps(pauses: TimeSpan[], firstAt: number | null, lastAt: number | null, from: number, to: number, minMs: number): TimeSpan[] {
  if (to <= from) return [];
  if (firstAt === null || lastAt === null) return [{ from, to }];
  const out = pauses.filter((p) => p.to - p.from >= minMs);
  if (firstAt - from >= minMs) out.unshift({ from, to: firstAt });
  if (to - lastAt >= minMs) out.push({ from: lastAt, to });
  return out;
}

/** The shift a person is on: their own shift, else their branch's, else the default one. */
export function shiftOf(s: AttendanceSettingsDto, objectId: string, branchId: string | null): { name: string; days: number[]; startMin: number; endMin: number } {
  const shift = s.shifts.find((x) => x.objectIds.includes(objectId)) ?? (branchId ? s.shifts.find((x) => x.branchIds.includes(branchId)) : undefined);
  return shift ?? { name: 'Default', days: s.days, startMin: s.startMin, endMin: s.endMin };
}

/** Whether a work site counts for a person: their own branch's, one without a branch, or any if allowed. */
export function siteCountsFor(s: Pick<AttendanceSettingsDto, 'anyBranchObjectIds'>, objectId: string, branchId: string | null, siteBranchId: string | null): boolean {
  return !branchId || !siteBranchId || siteBranchId === branchId || s.anyBranchObjectIds.includes(objectId);
}

function hoursError(startMin: number, endMin: number, days: number[]): string | null {
  if (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Invalid day';
  if (![startMin, endMin].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)) return 'Invalid time';
  if (endMin <= startMin) return 'The end time must be after the start time';
  return null;
}

export function attendanceSettingsError(s: AttendanceSettingsDto): string | null {
  if (s.enabled && !s.geofenceIds.length) return 'Choose at least one work-site geofence';
  const hours = hoursError(s.startMin, s.endMin, s.days);
  if (hours) return hours;
  if (!Number.isInteger(s.graceMin) || s.graceMin < 0 || s.graceMin > 180) return 'Grace must be 0–180 minutes';
  if (!Number.isInteger(s.shortExitMin) || s.shortExitMin < 0 || s.shortExitMin > 60) return 'Short exit must be 0–60 minutes';
  if (!Number.isInteger(s.noSignalMin) || s.noSignalMin < 15 || s.noSignalMin > 240) return 'No signal must be 15–240 minutes';
  if (!Number.isInteger(s.outReminderMin) || s.outReminderMin < 0 || s.outReminderMin > 720) return 'The reminder must be 0–720 minutes';
  if (!Number.isInteger(s.halfDayMin) || !Number.isInteger(s.fullDayMin) || s.halfDayMin < 0 || s.fullDayMin > 1440 || s.halfDayMin > s.fullDayMin) return 'Half day hours cannot be more than full day hours';
  const names = new Set<string>();
  for (const shift of s.shifts) {
    const name = typeof shift.name === 'string' ? shift.name.trim() : '';
    if (!name) return 'Every shift needs a name';
    if (name.length > 60) return 'Shift names can be 60 characters at most';
    if (names.has(name.toLowerCase())) return 'Shift names must be different';
    names.add(name.toLowerCase());
    const error = hoursError(shift.startMin, shift.endMin, shift.days);
    if (error) return error;
  }
  return null;
}
