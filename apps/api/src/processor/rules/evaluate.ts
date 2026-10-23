import { ackRequiredFor, AlertSeverity, AlertTypeCode, EffectiveAlertSetting } from '@veetracer/shared';
import { GeofenceRuntime, isSnoozed } from '../../alerts/rules-data';
import { GEOFENCE_BUFFER_M, inBBox, signedDistanceM, updateMembership } from '../../alerts/logic/geofence-geometry';
import { formatDuration, inAnyTimeWindow, inDailyRange } from '../../alerts/logic/time-window';
import { haversineMeters } from '../../tracking/geo';

/** Episodes end when no point arrived for this long. */
export const EPISODE_GAP_MS = 5 * 60_000;
/** Engine considered running without an ignition wire above this external voltage. */
export const ENGINE_ON_VOLTAGE = 13.2;
const LOW_BATTERY_HYSTERESIS_PCT = 5;
const COOLDOWN_PRUNE_MS = 24 * 3600_000;

export interface GeofenceMembership {
  in: boolean;
  since: number;
  pc: number; // pending count
  ps: number | null; // pending since
  visitId?: string;
  stay?: boolean; // GEOFENCE_STAY already raised for this visit
  os?: boolean; // currently overspeeding inside (GEOFENCE_OVERSPEED raised)
}

export interface OverspeedEpisode {
  start: number;
  last: number;
  max: number;
  limit: number;
  alertId: string | null;
  lastAlertAt: number | null;
  critical: boolean;
}

export interface IdleEpisode {
  start: number;
  last: number;
  lat: number;
  lng: number;
  level: 0 | 1 | 2; // 0 none, 1 warning raised, 2 critical raised
  alertId: string | null;
  lastAlertAt: number | null;
}

/** Persisted per object in `vt:alertstate:<objectId>`. */
export interface AlertState {
  gf: Record<string, GeofenceMembership>;
  os?: OverspeedEpisode;
  idle?: IdleEpisode;
  ign?: boolean | null;
  batLow?: boolean;
  /** Device health episodes: start time (server clock) and whether the alert was raised. */
  gpsLost?: { since: number; alerted: boolean };
  gsmWeak?: { since: number; alerted: boolean };
  powerLow?: { since: number; alerted: boolean };
  /** Last external voltage, to detect a drop to ~0 V (main power removed). */
  extV?: number;
  /** Last "external power connected" flag (trackers without a voltage reading, e.g. Concox GT06N). */
  chg?: boolean;
  /** Dashcam video alarm flags on the last point (they stay set while the fault lasts). */
  vid?: string[];
  /** AC on with the ignition off: since when, and whether AC_ON_ENGINE_OFF was raised. */
  acEo?: { since: number; alerted: boolean };
  /** DOOR_OPEN_WHILE_MOVING raised for the current door-open period. */
  doorMv?: boolean;
  /** Last SIM ICCID the tracker reported: a different one = SIM_CHANGED. */
  iccid?: string;
  /** Last alert time per cooldown key (alert type, or type:geofenceId). */
  cd: Record<string, number>;
}

/**
 * Overspeed limit, most specific first: an Alert Settings limit set on this vehicle → the limit set on the vehicle itself
 * (vehicle / device form) → an Alert Settings limit inherited from company, branch or group → the vehicle-type default.
 */
export function overspeedLimit(settingLimit: number | null, settingSource: string | undefined, object: Pick<RuleObject, 'speedLimitKph' | 'ownSpeedLimitKph'>): number | null {
  if (settingLimit !== null && settingSource === 'OBJECT') return settingLimit;
  if (object.ownSpeedLimitKph != null) return object.ownSpeedLimitKph;
  return settingLimit ?? object.speedLimitKph;
}

export const emptyAlertState = (): AlertState => ({ gf: {}, cd: {} });

export interface RuleObject {
  objectId: string;
  companyId: string;
  branchId: string | null;
  name: string;
  plateNumber: string | null;
  deviceId: string | null;
  /** Effective speed limit of the object (own limit or vehicle-type default), null = never overspeeds. */
  speedLimitKph: number | null;
  /** Limit set on the vehicle itself (vehicle / device form); null or absent = not set. */
  ownSpeedLimitKph?: number | null;
  /** VEHICLE / PERSON / ASSET / PET (power-connected checks only make sense for wired vehicle trackers). */
  type?: string;
}

export interface RuleInput {
  object: RuleObject;
  fixTime: number;
  lat: number;
  lng: number;
  speedKph: number;
  ignition: boolean | null;
  attributes: Record<string, unknown>;
  /**
   * False when the point has no valid GPS fix: only rules that don't depend on location run (ignition, SOS/power-cut
   * alarms, battery); lat/lng are then the last known location, or NaN when there is none. Default true.
   */
  locationValid?: boolean;
  /** When the server received the point (ms). Defaults to fixTime. Used for health durations and for alerts from
   * points without a fix, whose device time can't be trusted. */
  receivedAt?: number;
  /** The object was OFFLINE (offline sweeper) until this point: server time of its last data before. */
  offlineSince?: number;
  /** Only run device-health checks (points that don't update live state, e.g. a clock running ahead). */
  healthOnly?: boolean;
  /**
   * Only the tracker's own alarms (SOS, power cut, tamper, crash, towing…): a point dated before the last one (e.g. an
   * alarm packet stamped with an old GPS fix), which must not move live state but must still alert. Alerts are dated
   * by the server clock.
   */
  alarmsOnly?: boolean;
  /** Fix time (ms) of the last valid GPS position the shown lat/lng come from, when this point has no fix. */
  lastFixAt?: number;
  /** Refills / drains the fuel detector reported on this point (already stored as FuelEvent rows). */
  fuelEvents?: FuelAlertEvent[];
  /** AC / door sensor state (debounced) and changes on this point, when the vehicle's tracker has them configured. */
  io?: IoAlertInput;
}

export interface IoAlertInput {
  acOn: boolean | null;
  doorOpen: boolean | null;
  transitions: { kind: 'AC' | 'DOOR'; on: boolean; at: number; previousSec: number | null }[];
  /** Attributes wired to a sensor (e.g. GT800 extVoltage = AC blower wire): not the vehicle battery. */
  wired?: string[];
}

export interface FuelAlertEvent {
  id: string;
  type: 'REFILL' | 'DRAIN';
  startTime: number;
  endTime: number;
  litresBefore: number;
  litresAfter: number;
  deltaL: number;
  lat: number | null;
  lng: number | null;
}

export interface PendingAlert {
  id: string;
  type: AlertTypeCode;
  severity: AlertSeverity;
  message: string;
  occurredAt: number;
  lat: number | null;
  lng: number | null;
  geofenceId: string | null;
  geofenceName: string | null;
  data: Record<string, unknown>;
  /** Resolved when raised (Alert Settings `requireAck`, else the default rule on this alert's severity); stored on the alert. */
  ackRequired: boolean;
}

export type VisitOp =
  | { kind: 'open'; id: string; geofenceId: string; enterTime: number }
  | { kind: 'close'; id: string; exitTime: number; durationSec: number };

export interface EvalContext {
  settings: Map<AlertTypeCode, EffectiveAlertSetting>;
  geofences: GeofenceRuntime[];
  timezone: string;
  newId: () => string;
}

export interface EvalOutput {
  alerts: PendingAlert[];
  visits: VisitOp[];
  /** Merge into an existing alert's data (end-of-event summaries). */
  dataUpdates: { alertId: string; data: Record<string, unknown> }[];
}

/** Dashcam event attribute (JT/T 808 decoder `dms` / `adas`) → alert type and message. */
const DMS_ALERTS: Record<string, [AlertTypeCode, string]> = {
  fatigue: ['DRIVER_FATIGUE', 'Driver fatigue detected'],
  phone: ['DRIVER_PHONE', 'Driver using a phone'],
  smoking: ['DRIVER_SMOKING', 'Driver smoking'],
  distraction: ['DRIVER_DISTRACTED', 'Driver distracted'],
  driverAbsent: ['DRIVER_ABSENT', 'Driver not detected in the seat'],
  cameraBlocked: ['CAMERA_FAULT', 'Driver camera blocked'],
};
const ADAS_ALERTS: Record<string, [AlertTypeCode, string]> = {
  fcw: ['FORWARD_COLLISION_WARNING', 'Forward collision warning'],
  pcw: ['FORWARD_COLLISION_WARNING', 'Pedestrian collision warning'],
  obstacle: ['FORWARD_COLLISION_WARNING', 'Obstacle warning'],
  ldw: ['LANE_DEPARTURE', 'Lane departure'],
  laneChange: ['LANE_DEPARTURE', 'Frequent lane changes'],
  hmw: ['TAILGATING', 'Following too close'],
};
const VIDEO_FAULTS: Record<string, string> = {
  videoSignalLost: 'video signal lost',
  videoSignalBlocked: 'camera covered',
  storageFault: 'video storage failure',
};

const num = (v: unknown, fallback: number | null = null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Gate shared by every alert: supported by the device, enabled, inside the schedule (company timezone), not snoozed
 * (mandatory types ignore snoozes — resolution never marks them snoozed) and outside the cooldown.
 */
export function canEmit(
  setting: EffectiveAlertSetting | undefined,
  state: AlertState,
  cooldownKey: string,
  at: number,
  timezone: string,
): setting is EffectiveAlertSetting {
  if (!setting || !setting.supported || !setting.enabled) return false;
  if (setting.schedule && !inAnyTimeWindow([setting.schedule], at, timezone)) return false;
  if (isSnoozed(setting, at)) return false;
  const last = state.cd[cooldownKey];
  if (last !== undefined && setting.cooldownMin > 0 && at - last < setting.cooldownMin * 60_000) return false;
  return true;
}

class Evaluator {
  readonly out: EvalOutput = { alerts: [], visits: [], dataUpdates: [] };

  constructor(
    private readonly input: RuleInput,
    private readonly state: AlertState,
    private readonly ctx: EvalContext,
  ) {}

  emit(
    type: AlertTypeCode,
    opts: {
      severity?: AlertSeverity;
      message: string;
      data?: Record<string, unknown>;
      geofence?: GeofenceRuntime;
      at?: number;
      cooldownKey?: string;
      /**
       * The tracker itself raised this alarm: it proves the capability, so alert even when the device model doesn't
       * list it (a mis-set model must never swallow an SOS). Enabled / schedule / snooze / cooldown still apply.
       */
      deviceReported?: boolean;
    },
  ): string | null {
    const resolved = this.ctx.settings.get(type);
    const setting = opts.deviceReported && resolved && !resolved.supported ? { ...resolved, supported: true } : resolved;
    // A point without a GPS fix may carry a default device date (years off), and late / clock-ahead points aren't "now":
    // date those alerts by the server clock.
    const serverClock = this.input.locationValid === false || this.input.alarmsOnly === true || this.input.healthOnly === true;
    const at = opts.at ?? (serverClock ? this.now : this.input.fixTime);
    const cdKey = opts.cooldownKey ?? type;
    if (!canEmit(setting, this.state, cdKey, at, this.ctx.timezone)) return null;
    this.state.cd[cdKey] = at;
    const id = this.ctx.newId();
    const severity = opts.severity ?? setting.severity;
    this.out.alerts.push({
      id,
      type,
      severity,
      ackRequired: ackRequiredFor(setting, type, severity),
      message: opts.message,
      occurredAt: at,
      lat: Number.isFinite(this.input.lat) ? this.input.lat : null,
      lng: Number.isFinite(this.input.lng) ? this.input.lng : null,
      geofenceId: opts.geofence?.id ?? null,
      geofenceName: opts.geofence?.name ?? null,
      data: { speedKph: Math.round(this.input.speedKph), ...this.noFixData(), ...(opts.data ?? {}) },
    });
    return id;
  }

  /**
   * No GPS fix on this point: the alert's lat/lng are the last known location (or none), so say so, with the time of
   * that last fix. Shown in the apps and in the {{location}} of e-mails / custom templates.
   */
  private noFixData(): Record<string, unknown> {
    if (this.input.locationValid !== false) return {};
    const last = this.input.lastFixAt;
    return { noFix: true, ...(last !== undefined && Number.isFinite(this.input.lat) ? { lastFixAt: new Date(last).toISOString() } : {}) };
  }

  /** Server time of the point. */
  private get now(): number {
    return this.input.receivedAt ?? this.input.fixTime;
  }

  run(): EvalOutput {
    if (this.input.alarmsOnly) {
      this.alarms();
      this.dashcamAlarm();
      this.pruneCooldowns();
      return this.out;
    }
    if (this.input.healthOnly) {
      this.health();
      this.connection();
      // Clock running ahead: the alarm itself is still real and current.
      this.alarms();
      this.dashcamAlarm();
      return this.out;
    }
    if (this.input.locationValid !== false) {
      this.geofences();
      this.overspeed();
      this.idling();
    }
    this.ignition();
    this.alarms();
    this.dashcam();
    this.battery();
    this.fuel();
    this.ioSensors();
    this.health();
    this.connection();
    this.pruneCooldowns();
    return this.out;
  }

  // ───────────── geofences ─────────────
  private geofences(): void {
    const { lat, lng, fixTime, speedKph } = this.input;
    const applicable = new Set<string>();
    for (const g of this.ctx.geofences) {
      applicable.add(g.id);
      const m = this.state.gf[g.id];
      const near = inBBox(g.bbox, lat, lng, GEOFENCE_BUFFER_M + 5);
      if (!m && !near) continue; // outside and nothing pending: nothing to track
      const d = near ? signedDistanceM(g.geometry, lat, lng) : Number.POSITIVE_INFINITY;
      const prev = m
        ? { inside: m.in, since: m.since, pendingCount: m.pc, pendingSince: m.ps }
        : { inside: false, since: fixTime, pendingCount: 0, pendingSince: null };
      const { state: next, event, at } = updateMembership(prev, d, fixTime);
      const membership: GeofenceMembership = { ...(m ?? {}), in: next.inside, since: next.since, pc: next.pendingCount, ps: next.pendingSince };
      const windowOk = inAnyTimeWindow(g.timeWindows, at, this.ctx.timezone);

      if (event === 'ENTER') {
        const visitId = this.ctx.newId();
        this.out.visits.push({ kind: 'open', id: visitId, geofenceId: g.id, enterTime: at });
        membership.visitId = visitId;
        membership.stay = false;
        membership.os = false;
        if ((g.notifyEnter || g.mode === 'NO_GO') && windowOk) {
          this.emit('GEOFENCE_ENTER', {
            severity: g.mode === 'NO_GO' ? 'CRITICAL' : undefined,
            message: g.mode === 'NO_GO' ? `Entered no-go zone ${g.name}` : `Entered ${g.name}`,
            data: { geofence: g.name, mode: g.mode },
            geofence: g,
            at,
            cooldownKey: `GEOFENCE_ENTER:${g.id}`,
          });
        }
      } else if (event === 'EXIT') {
        const durationSec = Math.max(0, Math.round((at - (m?.since ?? at)) / 1000));
        if (m?.visitId) this.out.visits.push({ kind: 'close', id: m.visitId, exitTime: at, durationSec });
        delete membership.visitId;
        if ((g.notifyExit || g.mode === 'KEEP_IN') && windowOk) {
          this.emit('GEOFENCE_EXIT', {
            severity: g.mode === 'KEEP_IN' ? 'CRITICAL' : undefined,
            message: g.mode === 'KEEP_IN' ? `Left keep-inside zone ${g.name}` : `Left ${g.name}`,
            data: { geofence: g.name, mode: g.mode, durationSec },
            geofence: g,
            at,
            cooldownKey: `GEOFENCE_EXIT:${g.id}`,
          });
        }
      }

      if (membership.in && event !== 'ENTER') {
        if (g.maxStayMin && !membership.stay && fixTime - membership.since >= g.maxStayMin * 60_000) {
          membership.stay = true;
          if (windowOk) {
            const durationSec = Math.round((fixTime - membership.since) / 1000);
            this.emit('GEOFENCE_STAY', {
              message: `In ${g.name} for ${formatDuration(durationSec)} (max ${g.maxStayMin} min)`,
              data: { geofence: g.name, durationSec, maxStayMin: g.maxStayMin },
              geofence: g,
              cooldownKey: `GEOFENCE_STAY:${g.id}`,
            });
          }
        }
      }
      if (membership.in && g.speedLimitKph) {
        if (speedKph > g.speedLimitKph) {
          if (!membership.os) {
            membership.os = true;
            if (windowOk) {
              this.emit('GEOFENCE_OVERSPEED', {
                message: `${Math.round(speedKph)} km/h inside ${g.name} (limit ${g.speedLimitKph} km/h)`,
                data: { geofence: g.name, limitKph: g.speedLimitKph },
                geofence: g,
                cooldownKey: `GEOFENCE_OVERSPEED:${g.id}`,
              });
            }
          }
        } else membership.os = false;
      }

      if (!membership.in && membership.pc === 0) delete this.state.gf[g.id];
      else this.state.gf[g.id] = membership;
    }
    // Geofences deleted, deactivated or no longer applicable: close open visits silently.
    for (const [id, m] of Object.entries(this.state.gf)) {
      if (applicable.has(id)) continue;
      if (m.in && m.visitId) {
        this.out.visits.push({ kind: 'close', id: m.visitId, exitTime: fixTime, durationSec: Math.max(0, Math.round((fixTime - m.since) / 1000)) });
      }
      delete this.state.gf[id];
    }
  }

  // ───────────── overspeed ─────────────
  private overspeed(): void {
    const setting = this.ctx.settings.get('OVERSPEED');
    const p = setting?.params ?? {};
    const { fixTime, speedKph } = this.input;
    let ep = this.state.os;
    if (ep && fixTime - ep.last > EPISODE_GAP_MS) {
      this.endOverspeed(ep);
      ep = undefined;
    }
    const baseLimit = overspeedLimit(num(p.limitKph), setting?.sources['params.limitKph'], this.input.object);
    const nightLimit = num(p.nightLimitKph);
    const night = nightLimit !== null && inDailyRange(p.nightFrom, p.nightTo, fixTime, this.ctx.timezone);
    const limit = night ? nightLimit : baseLimit;
    if (limit === null) {
      if (ep) this.endOverspeed(ep);
      return;
    }
    const tolerance = num(p.toleranceKph, 5)!;
    const over = speedKph > limit + tolerance;
    if (!over) {
      if (ep) this.endOverspeed(ep);
      return;
    }
    if (!ep) ep = { start: fixTime, last: fixTime, max: speedKph, limit, alertId: null, lastAlertAt: null, critical: false };
    ep.last = fixTime;
    ep.max = Math.max(ep.max, speedKph);
    ep.limit = limit;
    this.state.os = ep;

    const durationSec = Math.round((fixTime - ep.start) / 1000);
    const critical = speedKph > limit + num(p.criticalOverKph, 20)!;
    const data = { limitKph: limit, maxSpeedKph: Math.round(ep.max), toleranceKph: tolerance, night, durationSec };
    const message = `Overspeed: ${Math.round(speedKph)} km/h (limit ${limit} km/h)`;
    if (!ep.alertId) {
      if (durationSec * 1000 < num(p.minDurationSec, 10)! * 1000) return;
      const id = this.emit('OVERSPEED', { severity: critical ? 'CRITICAL' : undefined, message, data });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
        ep.critical = critical;
      }
      return;
    }
    if (critical && !ep.critical) {
      const id = this.emit('OVERSPEED', { severity: 'CRITICAL', message, data: { ...data, escalated: true } });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
        ep.critical = true;
      }
      return;
    }
    const repeatMin = num(p.repeatEveryMin, 0)!;
    if (repeatMin > 0 && ep.lastAlertAt !== null && fixTime - ep.lastAlertAt >= repeatMin * 60_000) {
      const id = this.emit('OVERSPEED', { severity: ep.critical ? 'CRITICAL' : undefined, message, data: { ...data, repeat: true } });
      if (id) {
        ep.alertId = id;
        ep.lastAlertAt = fixTime;
      }
    }
  }

  private endOverspeed(ep: OverspeedEpisode): void {
    if (ep.alertId) {
      this.out.dataUpdates.push({
        alertId: ep.alertId,
        data: {
          endedAt: new Date(ep.last).toISOString(),
          durationSec: Math.round((ep.last - ep.start) / 1000),
          maxSpeedKph: Math.round(ep.max),
          limitKph: ep.limit,
        },
      });
    }
    delete this.state.os;
  }

  // ───────────── idling ─────────────
  private idling(): void {
    const setting = this.ctx.settings.get('IDLING');
    const p = setting?.params ?? {};
    const { fixTime, speedKph, ignition, lat, lng } = this.input;
    let ep = this.state.idle;
    if (ep && fixTime - ep.last > EPISODE_GAP_MS) {
      this.endIdle(ep);
      ep = undefined;
    }
    const extVoltage = this.batteryVoltage();
    const engineOn = ignition === true || (ignition === null && extVoltage !== null && extVoltage > ENGINE_ON_VOLTAGE);
    const idleNow = engineOn && speedKph < num(p.speedBelowKph, 3)!;
    if (!idleNow) {
      if (ep) this.endIdle(ep);
      return;
    }
    const tolerance = num(p.movementToleranceM, 50)!;
    if (ep && haversineMeters(ep.lat, ep.lng, lat, lng) > tolerance) {
      this.endIdle(ep);
      ep = undefined;
    }
    if (!ep) ep = { start: fixTime, last: fixTime, lat, lng, level: 0, alertId: null, lastAlertAt: null };
    ep.last = fixTime;
    this.state.idle = ep;

    const excluded = Array.isArray(p.excludeGeofenceIds) && (p.excludeGeofenceIds as string[]).some((id) => this.state.gf[id]?.in);
    if (excluded) return;
    const elapsed = fixTime - ep.start;
    const durationSec = Math.round(elapsed / 1000);
    const message = `Idling for ${formatDuration(durationSec)}`;
    const data = { durationSec };
    const criticalMs = num(p.criticalMin, 30)! * 60_000;
    const warnMs = num(p.thresholdMin, 10)! * 60_000;
    let raised: string | null = null;
    if (elapsed >= criticalMs && ep.level < 2) {
      raised = this.emit('IDLING', { severity: 'CRITICAL', message, data });
      if (raised) ep.level = 2;
    } else if (elapsed >= warnMs && ep.level < 1) {
      raised = this.emit('IDLING', { message, data });
      if (raised) ep.level = 1;
    } else if (ep.level > 0) {
      const repeatMin = num(p.repeatEveryMin, 15)!;
      if (repeatMin > 0 && ep.lastAlertAt !== null && fixTime - ep.lastAlertAt >= repeatMin * 60_000) {
        raised = this.emit('IDLING', { severity: ep.level === 2 ? 'CRITICAL' : undefined, message, data: { ...data, repeat: true } });
      }
    }
    if (raised) {
      ep.alertId = raised;
      ep.lastAlertAt = fixTime;
    }
  }

  private endIdle(ep: IdleEpisode): void {
    if (ep.alertId) {
      this.out.dataUpdates.push({
        alertId: ep.alertId,
        data: { endedAt: new Date(ep.last).toISOString(), durationSec: Math.round((ep.last - ep.start) / 1000) },
      });
    }
    delete this.state.idle;
  }

  // ───────────── ignition / alarms / battery ─────────────
  private ignition(): void {
    const { ignition } = this.input;
    const prev = this.state.ign;
    if (ignition !== null && prev !== undefined && prev !== null && prev !== ignition) {
      this.emit(ignition ? 'IGNITION_ON' : 'IGNITION_OFF', { message: ignition ? 'Ignition switched on' : 'Ignition switched off' });
    }
    if (ignition !== null) this.state.ign = ignition;
  }

  /**
   * Alarms the tracker raised itself (attributes.alarm, normalised by the decoders; see gateway/attributes.ts).
   * Device-side overspeed and geofence alarms are deliberately ignored: VeeTrax evaluates speed limits and geofences
   * itself, with the customer's own limits and zones. crash / rollover / fatigue / cameraFault: see dashcamAlarm().
   */
  private alarms(): void {
    const alarm = this.input.attributes.alarm;
    const raise = (type: AlertTypeCode, message: string) => this.emit(type, { message, data: { alarm }, deviceReported: true });
    if (alarm === 'sos') raise('SOS', 'SOS / panic button pressed');
    else if (alarm === 'powerCut') raise('POWER_CUT', 'Tracker main power disconnected');
    else if (alarm === 'tamper') raise('DEVICE_TAMPER', 'Tracker reported tampering (case opened or removed)');
    else if (alarm === 'jamming') raise('DEVICE_TAMPER', 'Tracker reported GPS/GSM jamming');
    else if (alarm === 'gpsAntennaCut') raise('DEVICE_TAMPER', 'GPS antenna disconnected (possible tampering)');
    else if (alarm === 'gpsAntennaShort') raise('GPS_FAULT', 'GPS antenna short-circuited');
    else if (alarm === 'gnssFault') raise('GPS_FAULT', 'Tracker reported a GPS module fault');
    else if (alarm === 'towing') raise('TOWING', 'Vehicle moved with the engine off (towing?)');
    else if (alarm === 'illegalIgnition') raise('TOWING', 'Ignition switched on without authorisation');
    else if (alarm === 'illegalDoorOpen') raise('TOWING', 'Door opened without authorisation');
    else if (alarm === 'vibration') raise('VIBRATION', 'Tracker detected vibration / a shock');
    else if (alarm === 'powerLow') raise('POWER_LOW', 'Tracker reported low vehicle battery voltage');
    else if (alarm === 'lowBattery') {
      // The tracker's own low-battery alarm, for trackers that report no battery %. With a %, battery() decides.
      const level = num(this.input.attributes.batteryLevel);
      if (level === null) raise('LOW_BATTERY', 'Tracker battery low');
      else if (!this.state.batLow) {
        this.state.batLow = true;
        this.emit('LOW_BATTERY', { message: `Tracker battery low (${Math.round(level)}%)`, data: { alarm, batteryPct: Math.round(level) }, deviceReported: true });
      }
    } else if (alarm === 'harshAcceleration' || alarm === 'harshBraking' || alarm === 'harshCornering') {
      // Driving behaviour the tracker detected itself (Teltonika adds the g-force as greenDrivingValue).
      const speed = Math.round(this.input.speedKph);
      const g = typeof this.input.attributes.greenDrivingValue === 'number' ? ` (${this.input.attributes.greenDrivingValue})` : '';
      const [type, what] =
        alarm === 'harshAcceleration'
          ? (['HARSH_ACCELERATION', 'Harsh acceleration'] as const)
          : alarm === 'harshBraking'
            ? (['HARSH_BRAKING', 'Harsh braking'] as const)
            : (['HARSH_CORNERING', 'Harsh cornering'] as const);
      this.emit(type, { message: `${what} at ${speed} km/h${g}`, data: { alarm } });
    } else if (typeof alarm === 'string' && /^alarm_(?!0$)\w+$/.test(alarm)) {
      // Unrecognised alarm code (alarm_0 = none): may be a new model's SOS, so surface it instead of dropping it.
      this.emit('UNKNOWN_ALARM', { message: `Tracker sent unrecognised alarm code ${alarm.slice(6)} — check the device (it may be an SOS)`, data: { alarm } });
    }
  }

  // ───────────── dashcam: driver monitoring (DMS), road ADAS, camera health, crash ─────────────
  private dashcam(): void {
    const a = this.input.attributes;
    // Events from buffered history uploads are old news: never alert on them (the tracker's live state moved on).
    if (a.reupload === true) return;
    const speed = Math.round(this.input.speedKph);
    const atLevel = (level: number | null) => (level === null ? '' : ` (level ${level})`);
    const raise = (type: AlertTypeCode, message: string, data: Record<string, unknown>, level: number | null = null) => {
      if (level !== null && level < this.param(type, 'minLevel', 1)) return;
      this.emit(type, { message, data: { ...data, level, speedKph: speed } });
    };

    if (typeof a.dms === 'string') {
      const level = num(a.dmsLevel);
      const dms = DMS_ALERTS[a.dms];
      if (dms) raise(dms[0], `${dms[1]}${atLevel(level)}`, { event: a.dms, source: 'dms' }, dms[0] === 'CAMERA_FAULT' ? null : level);
    }
    if (typeof a.adas === 'string') {
      const level = num(a.adasLevel);
      const adas = ADAS_ALERTS[a.adas];
      if (adas) raise(adas[0], `${adas[1]} at ${speed} km/h${atLevel(level)}`, { event: a.adas, source: 'adas' }, level);
    }

    this.dashcamAlarm();

    // Video alarm flags stay set while the fault lasts: alert when a flag appears.
    const flags = typeof a.videoAlarm === 'string' ? a.videoAlarm.split(',').filter((f) => VIDEO_FAULTS[f]) : [];
    const added = flags.filter((f) => !this.state.vid?.includes(f));
    if (added.length) raise('CAMERA_FAULT', `Camera fault: ${added.map((f) => VIDEO_FAULTS[f]).join(', ')}`, { event: added.join(','), source: 'video' });
    if (flags.length) this.state.vid = flags;
    else delete this.state.vid;
  }

  /** Crash / rollover / fatigue / camera fault from the tracker's alarm field (also on late points; not on history). */
  private dashcamAlarm(): void {
    const alarm = this.input.attributes.alarm;
    if (this.input.attributes.reupload === true) return;
    const speed = Math.round(this.input.speedKph);
    const raise = (type: AlertTypeCode, message: string) =>
      this.emit(type, { message, data: { event: alarm, source: 'alarm', level: null, speedKph: speed }, deviceReported: true });
    if (alarm === 'fatigue') raise('DRIVER_FATIGUE', 'Fatigue driving reported by the tracker');
    else if (alarm === 'crash') raise('CRASH', `Collision detected at ${speed} km/h`);
    else if (alarm === 'rollover') raise('CRASH', `Vehicle rollover detected at ${speed} km/h`);
    else if (alarm === 'cameraFault') raise('CAMERA_FAULT', 'Tracker reported a camera fault');
  }

  private battery(): void {
    const level = num(this.input.attributes.batteryLevel);
    if (level === null) return;
    const threshold = num(this.ctx.settings.get('LOW_BATTERY')?.params.thresholdPct, 20)!;
    if (level < threshold && !this.state.batLow) {
      this.state.batLow = true;
      this.emit('LOW_BATTERY', { message: `Tracker battery at ${Math.round(level)}%`, data: { batteryPct: Math.round(level), thresholdPct: threshold } });
    } else if (level >= threshold + LOW_BATTERY_HYSTERESIS_PCT && this.state.batLow) {
      this.state.batLow = false;
    }
  }

  // ───────────── fuel refill / drain (detected by the processor's fuel detector) ─────────────
  private fuel(): void {
    for (const e of this.input.fuelEvents ?? []) {
      const data = { litresBefore: e.litresBefore, litresAfter: e.litresAfter, deltaL: e.deltaL, fuelEventId: e.id, startedAt: new Date(e.startTime).toISOString() };
      const level = `${e.litresBefore.toFixed(1)} → ${e.litresAfter.toFixed(1)} L`;
      if (e.type === 'DRAIN') {
        this.emit('FUEL_DRAIN', { at: e.endTime, message: `Possible fuel theft: ${e.deltaL.toFixed(1)} L drained (${level})`, data, cooldownKey: `FUEL_DRAIN:${e.id}` });
      } else {
        this.emit('FUEL_REFILL', { at: e.endTime, message: `Refuelled ${e.deltaL.toFixed(1)} L (${level})`, data, cooldownKey: `FUEL_REFILL:${e.id}` });
      }
    }
  }

  /** extVoltage as the vehicle battery, unless an AC / door sensor is wired to it. */
  private batteryVoltage(): number | null {
    return this.input.io?.wired?.includes('extVoltage') ? null : num(this.input.attributes.extVoltage);
  }

  // ───────────── connection: back online after a silence (SIM / power / network restored); SIM card swapped ─────────────
  private connection(): void {
    // Back from OFFLINE (the same status that raised DEVICE_OFFLINE), so sleeping trackers with long report intervals
    // don't alert unless they were actually marked offline.
    const since = this.input.offlineSince;
    if (since !== undefined && this.now > since) {
      const durationSec = Math.round((this.now - since) / 1000);
      this.emit('DEVICE_ONLINE', { message: `Back online after ${formatDuration(durationSec)} without data`, data: { durationSec, lastSeen: new Date(since).toISOString() } });
    }
    const iccid = typeof this.input.attributes.iccid === 'string' && this.input.attributes.iccid ? this.input.attributes.iccid : null;
    if (iccid) {
      const previous = this.state.iccid;
      if (previous && previous !== iccid) {
        this.emit('SIM_CHANGED', { message: `SIM card changed (…${previous.slice(-6)} → …${iccid.slice(-6)})`, data: { previousIccid: previous, iccid } });
      }
      this.state.iccid = iccid;
    }
  }

  // ───────────── AC / door sensors (state debounced by the processor) ─────────────
  private ioSensors(): void {
    const io = this.input.io;
    if (!io) return;
    for (const t of io.transitions) {
      const data = t.previousSec === null ? {} : { durationSec: t.previousSec };
      if (t.kind === 'AC') this.emit(t.on ? 'AC_ON' : 'AC_OFF', { at: t.at, message: t.on ? 'AC switched on' : 'AC switched off', data: t.on ? {} : data });
      else this.emit(t.on ? 'DOOR_OPEN' : 'DOOR_CLOSED', { at: t.at, message: t.on ? 'Door opened' : 'Door closed', data: t.on ? {} : data });
    }
    const { fixTime, ignition, speedKph } = this.input;

    // AC running with the ignition off for N minutes (drains the battery).
    if (io.acOn === true && ignition === false) {
      const ep = (this.state.acEo ??= { since: fixTime, alerted: false });
      const durationSec = Math.round((fixTime - ep.since) / 1000);
      if (!ep.alerted && durationSec >= this.param('AC_ON_ENGINE_OFF', 'minutes', 10) * 60) {
        ep.alerted = true;
        this.emit('AC_ON_ENGINE_OFF', { message: `AC running with the ignition off for ${formatDuration(durationSec)}`, data: { durationSec } });
      }
    } else delete this.state.acEo;

    // Door open while driving: once per door-open period.
    if (io.doorOpen === true) {
      const limit = this.param('DOOR_OPEN_WHILE_MOVING', 'speedKph', 10);
      if (!this.state.doorMv && this.input.locationValid !== false && speedKph > limit) {
        this.state.doorMv = true;
        this.emit('DOOR_OPEN_WHILE_MOVING', { message: `Door open while moving at ${Math.round(speedKph)} km/h`, data: { limitKph: limit } });
      }
    } else if (io.doorOpen === false) delete this.state.doorMv;
  }

  // ───────────── device health (data-driven) ─────────────
  private param(type: AlertTypeCode, key: string, fallback: number): number {
    return num(this.ctx.settings.get(type)?.params[key], fallback)!;
  }

  /** Starts / continues / clears a health episode and raises its alert once when it lasted long enough. */
  private episode(
    key: 'gpsLost' | 'gsmWeak' | 'powerLow',
    active: boolean,
    afterMin: number,
    raise: (durationSec: number) => void,
  ): void {
    if (!active) {
      delete this.state[key];
      return;
    }
    const ep = (this.state[key] ??= { since: this.now, alerted: false });
    const durationSec = Math.round((this.now - ep.since) / 1000);
    if (!ep.alerted && durationSec >= afterMin * 60) {
      ep.alerted = true;
      raise(durationSec);
    }
  }

  private health(): void {
    const { attributes } = this.input;
    const reupload = attributes.reupload === true;
    const fmt = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min` : `${Math.round(sec / 60)} min`);

    if (!this.input.healthOnly) {
      // GPS: data keeps arriving without a valid fix.
      this.episode('gpsLost', this.input.locationValid === false, this.param('GPS_LOST', 'afterMin', 30), (durationSec) =>
        this.emit('GPS_LOST', { at: this.now, message: `No GPS fix for ${fmt(durationSec)}`, data: { durationSec } }),
      );

      // GSM: weak mobile signal for a while.
      const gsm = num(attributes.gsmSignal);
      if (gsm !== null) {
        this.episode('gsmWeak', gsm <= this.param('GSM_WEAK', 'maxLevel', 1), this.param('GSM_WEAK', 'afterMin', 30), (durationSec) =>
          this.emit('GSM_WEAK', { at: this.now, message: `Mobile signal ${gsm}/4 for ${fmt(durationSec)}`, data: { durationSec, gsmSignal: gsm } }),
        );
      }

      // Power source: main power removed (voltage drops to ~0) or vehicle battery low.
      const v = this.batteryVoltage();
      if (v !== null) {
        const prev = this.state.extV;
        if (prev !== undefined && prev >= 6 && v < 1) {
          this.emit('POWER_CUT', { at: this.now, message: `Main power disconnected (${prev.toFixed(1)} V → ${v.toFixed(1)} V)`, data: { voltage: v, previousVoltage: prev, source: 'voltage' } });
        }
        const threshold = this.param('POWER_LOW', 'thresholdV', 11.5);
        const low = v >= 1 && v < threshold;
        // Small hysteresis so a voltage hovering at the threshold doesn't restart the episode.
        if (low || !this.state.powerLow || v >= threshold + 0.3) {
          this.episode('powerLow', low, this.param('POWER_LOW', 'afterMin', 10), () =>
            this.emit('POWER_LOW', { at: this.now, message: `Vehicle voltage low: ${v.toFixed(1)} V (below ${threshold} V)`, data: { voltage: v, thresholdV: threshold } }),
          );
        }
        this.state.extV = v;
      } else if (typeof this.input.attributes.charging === 'boolean' && this.input.object.type === 'VEHICLE') {
        // No voltage reported (e.g. GT06N): the tracker still says whether the vehicle supply is connected.
        const chg = this.input.attributes.charging;
        if (this.state.chg === true && !chg) {
          this.emit('POWER_CUT', { at: this.now, message: 'Vehicle power disconnected (tracker running on its own battery)', data: { source: 'powerFlag' } });
        }
        this.state.chg = chg;
      }

      // GPRS: live data arriving late = the tracker buffered it while the network was down.
      const delaySec = Math.round((this.now - this.input.fixTime) / 1000);
      if (this.input.locationValid !== false && !reupload && delaySec >= this.param('DATA_DELAYED', 'delayMin', 10) * 60 && delaySec < 7 * 86_400) {
        this.emit('DATA_DELAYED', { at: this.now, message: `Data arriving ${fmt(delaySec)} late (network / GPRS)`, data: { durationSec: delaySec } });
      }
    }

    // Clock: an impossible device time the processor replaced (reset clock: firmware / GPS problem).
    if (this.input.attributes.timeCorrected === 'device-clock') {
      this.emit('CLOCK_ERROR', { at: this.now, message: `Device clock is wrong (reports ${String(this.input.attributes.deviceTime ?? '?').slice(0, 10)}) — check the tracker's GPS / firmware`, data: { deviceTime: this.input.attributes.deviceTime } });
    }
    // Clock: device time ahead of the server (wrong time zone on the tracker).
    const aheadSec = Math.round((this.input.fixTime - this.now) / 1000);
    if (this.input.locationValid !== false && aheadSec >= this.param('CLOCK_ERROR', 'thresholdMin', 15) * 60) {
      this.emit('CLOCK_ERROR', { at: this.now, message: `Device clock is ${fmt(aheadSec)} ahead — check the time zone setting`, data: { durationSec: aheadSec } });
    }
  }

  private pruneCooldowns(): void {
    for (const [k, at] of Object.entries(this.state.cd)) if (this.input.fixTime - at > COOLDOWN_PRUNE_MS) delete this.state.cd[k];
  }
}

/** Evaluate one position against all rules; mutates `state` in place and returns the alerts/visit changes. */
export function evaluatePosition(input: RuleInput, state: AlertState, ctx: EvalContext): EvalOutput {
  return new Evaluator(input, state, ctx).run();
}
