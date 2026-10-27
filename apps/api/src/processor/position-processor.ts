import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { LiveObject, NormalizedPosition, POSITION_FLAGS } from '@veetracer/shared';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { emptyFuelState, fuelLitres, FuelState, stepFuel } from '../fuel/fuel-logic';
import { RedisKeys } from '../redis/keys';
import { parseLive } from '../tracking/live-object';
import { correctClock } from '../tracking/clock-correction';
import { nextStatus, StatusState } from '../tracking/movement-status';
import { EMPTY_TRACK_STATE, filterPosition, TrackState } from '../tracking/position-filter';
import { MOBILE_PROTOCOL } from '../mobile-tracker/mobile-tracker.logic';
import { DeviceCache, ResolvedDevice } from './device-cache';
import { isParkedRepeat } from './parked-thinning';
import { DriverIdentification } from './driver-identification';
import { FuelEventRow, IoSessionRow, PositionRow, RawPacketRow, UnknownDeviceRow, WriteBatch, writeBatch } from './position-writer';
import { IoAlertInput, RuleInput } from './rules/evaluate';
import { emptyIoKindState, ioReading, IoState, parseIoState, stepIo } from '../io-sensors/io-logic';
import { RulesBatch, RulesEngine } from './rules/rules-engine';
import { statusChangedEvent, vehicleState, WebhookEventMessage, WebhookEventPublisher } from '../webhooks/events';

const LAST_SEEN_THROTTLE_MS = 10_000;
const FUEL_STATE_TTL_SEC = 7 * 24 * 3600;
const IO_STATE_TTL_SEC = 7 * 24 * 3600;

/** Fuel detector state of the objects in one batch. */
interface FuelBatch {
  states: Map<string, FuelState>;
  changed: Set<string>;
  events: FuelEventRow[];
}

/** AC / door detector state of the objects in one batch. */
interface IoBatch {
  states: Map<string, IoState>;
  changed: Set<string>;
  sessions: IoSessionRow[];
}
const emptyIoBatch = (): IoBatch => ({ states: new Map(), changed: new Set(), sessions: [] });

function parseFuelState(json: string | null): FuelState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as FuelState;
    return Array.isArray(s?.buf) && Array.isArray(s?.hist) ? s : null;
  } catch {
    return null;
  }
}

export interface StreamEntry {
  id: string;
  data: string | null;
  remote: string | null;
}

interface Parsed {
  entry: StreamEntry;
  position: NormalizedPosition;
}

function numberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseTrack(json: string | null): TrackState | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as TrackState;
  } catch {
    return null;
  }
}

function parseEntry(entry: StreamEntry): NormalizedPosition | null {
  if (!entry.data) return null;
  try {
    const p = JSON.parse(entry.data) as NormalizedPosition;
    return typeof p.uniqueId === 'string' && typeof p.fixTime === 'string' ? p : null;
  } catch {
    return null;
  }
}

/**
 * One batch: resolve devices → filter/flag → status machine → live state + publish → batch insert → XACK.
 * Entries are acknowledged only after the database write succeeded.
 */
export class PositionProcessor {
  private readonly logger = new Logger('Processor');
  private readonly lastSeenWritten = new Map<string, number>();
  /** Last SIM ICCID saved per device, so a reported ICCID is written once, not with every point. */
  private readonly iccidSaved = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly cache: DeviceCache,
    private readonly rules: RulesEngine | null = null,
    private readonly drivers: DriverIdentification | null = null,
    private readonly webhooks: WebhookEventPublisher | null = null,
  ) {}

  /** Returns the number of entries processed (acknowledged). */
  async handle(entries: StreamEntry[]): Promise<number> {
    if (!entries.length) return 0;
    const now = Date.now();
    const serverTime = new Date(now).toISOString();

    const parsed: Parsed[] = [];
    for (const entry of entries) {
      const position = parseEntry(entry);
      if (position) parsed.push({ entry, position });
    }
    const devices = await this.cache.resolve(parsed.map((p) => p.position.uniqueId));

    const objectIds = new Set<string>();
    for (const { position } of parsed) {
      const d = devices.get(position.uniqueId);
      if (d?.accepted && d.object) objectIds.add(d.object.objectId);
    }
    const { lives, tracks } = await this.loadState([...objectIds]);
    const statusBefore = new Map([...lives].map(([id, l]) => [id, l.status]));
    const fuel = await this.loadFuel(parsed.map((p) => devices.get(p.position.uniqueId)));
    const io = await this.loadIo(parsed.map((p) => devices.get(p.position.uniqueId)));

    const batch: WriteBatch = { positions: [], rawPackets: [], unknownDevices: [], lastSeen: [] };
    const unknown = new Map<string, UnknownDeviceRow>();
    const changed = new Map<string, LiveObject>();
    const ruleInputs: RuleInput[] = [];

    for (const { entry, position } of parsed) {
      const device = devices.get(position.uniqueId);
      if (device === null || device === undefined) {
        const row = unknown.get(position.uniqueId);
        if (row) {
          row.count++;
          row.seenAt = position.receivedAt;
        } else {
          unknown.set(position.uniqueId, {
            uniqueId: position.uniqueId,
            protocol: position.protocol,
            remoteAddress: entry.remote,
            seenAt: position.receivedAt,
            count: 1,
          });
        }
        continue;
      }
      if (!device.accepted) continue;
      if (this.drivers && device.object) await this.drivers.apply(device.object, position);
      batch.positions.push(...this.evaluate(position, device, lives, tracks, changed, now, serverTime, ruleInputs, fuel, io));
      if (position.raw) batch.rawPackets.push(this.rawPacket(position, entry.remote));
      this.trackLastSeen(device.deviceId, now, serverTime, batch);
    }
    batch.unknownDevices = [...unknown.values()];
    batch.fuelEvents = fuel.events;
    batch.ioSessions = io.sessions;

    let rules = await this.evaluateRules(ruleInputs);
    if (changed.size) await this.publish(changed, tracks);
    if (changed.size && this.webhooks) await this.emitStatusChanges(changed, statusBefore);
    try {
      await writeBatch(this.prisma, batch, rules?.statements(this.prisma));
    } catch (error) {
      if (!rules) throw error;
      // Never let alert rows hold positions hostage: retry the batch without them (rule state is not committed).
      this.logger.error(`Batch write with alerts failed, retrying without: ${(error as Error).message}`);
      rules = null;
      await writeBatch(this.prisma, batch);
    }
    await this.saveFuel(fuel);
    await this.saveIo(io);
    await this.redis.xack(RedisKeys.positionsStream, RedisKeys.processorGroup, ...entries.map((e) => e.id));
    if (rules) await this.commitRules(rules);
    return entries.length;
  }

  private async loadState(objectIds: string[]) {
    const lives = new Map<string, LiveObject>();
    const tracks = new Map<string, TrackState>();
    if (!objectIds.length) return { lives, tracks };
    const values = await this.redis.mget(...objectIds.map(RedisKeys.live), ...objectIds.map(RedisKeys.track));
    objectIds.forEach((id, i) => {
      const live = parseLive(values[i]);
      const track = parseTrack(values[objectIds.length + i]);
      if (live) lives.set(id, live);
      if (track) tracks.set(id, track);
    });
    return { lives, tracks };
  }

  private async loadFuel(devices: (ResolvedDevice | null | undefined)[]): Promise<FuelBatch> {
    const out: FuelBatch = { states: new Map(), changed: new Set(), events: [] };
    const ids = [...new Set(devices.filter((d) => d?.accepted && d.object && d.fuel).map((d) => d!.object!.objectId))];
    if (!ids.length) return out;
    const values = await this.redis.mget(...ids.map(RedisKeys.fuelState));
    ids.forEach((id, i) => out.states.set(id, parseFuelState(values[i]) ?? emptyFuelState()));
    return out;
  }

  /** After the batch (and its fuel events) was written: persist the detector state. */
  private async saveFuel(fuel: FuelBatch): Promise<void> {
    if (!fuel.changed.size) return;
    const pipeline = this.redis.pipeline();
    for (const id of fuel.changed) pipeline.set(RedisKeys.fuelState(id), JSON.stringify(fuel.states.get(id)), 'EX', FUEL_STATE_TTL_SEC);
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) this.logger.error(`Fuel state update failed: ${failed[0].message}`);
  }

  private async loadIo(devices: (ResolvedDevice | null | undefined)[]): Promise<IoBatch> {
    const out = emptyIoBatch();
    const ids = [...new Set(devices.filter((d) => d?.accepted && d.object && d.io?.length).map((d) => d!.object!.objectId))];
    if (!ids.length) return out;
    const values = await this.redis.mget(...ids.map(RedisKeys.ioState));
    ids.forEach((id, i) => out.states.set(id, parseIoState(values[i])));
    return out;
  }

  /** After the batch (and its session rows) was written: persist the AC / door detector state. */
  private async saveIo(io: IoBatch): Promise<void> {
    if (!io.changed.size) return;
    const pipeline = this.redis.pipeline();
    for (const id of io.changed) pipeline.set(RedisKeys.ioState(id), JSON.stringify(io.states.get(id)), 'EX', IO_STATE_TTL_SEC);
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) this.logger.error(`AC / door state update failed: ${failed[0].message}`);
  }

  /**
   * AC / door sensors on a live point: reading → debounced state → session rows; the state goes into the position
   * attributes (`ac`, `doorOpen`) and LiveObject. Buffered history uploads only show their reading, never move the state.
   */
  private applyIo(
    object: NonNullable<ResolvedDevice['object']>,
    device: ResolvedDevice,
    position: NormalizedPosition,
    fixTime: number,
    loc: { lat: number | null; lng: number | null; trusted: boolean },
    prev: LiveObject | undefined,
    io: IoBatch,
  ): { live: Partial<LiveObject>; rule: IoAlertInput | undefined } {
    const sensors = device.io ?? [];
    const state = io.states.get(object.objectId);
    if (!sensors.length || !state) return { live: {}, rule: undefined };
    const attrs = position.attributes ?? {};
    const live: Partial<LiveObject> = {};
    const rule: IoAlertInput = { acOn: null, doorOpen: null, transitions: [], wired: sensors.map((s) => s.attribute) };
    const usable = attrs.reupload !== true;
    for (const cfg of sensors) {
      const st = (state[cfg.kind] ??= emptyIoKindState());
      const reading = ioReading(attrs, cfg, st.s);
      if (usable) {
        const step = stepIo(st, { t: fixTime, raw: reading.on, lat: loc.lat, lng: loc.lng, valid: loc.trusted, ignition: position.ignition }, cfg, randomUUID);
        io.changed.add(object.objectId);
        for (const r of step.rows) {
          io.sessions.push({
            ...r,
            companyId: object.companyId,
            objectId: object.objectId,
            startTime: new Date(r.startTime).toISOString(),
            endTime: r.endTime === null ? null : new Date(r.endTime).toISOString(),
          });
        }
        if (step.transition) rule.transitions.push(step.transition);
      }
      const on = st.s;
      if (cfg.kind === 'AC') {
        live.acOn = on;
        live.acVoltage = cfg.source === 'ANALOG' ? (reading.voltage ?? prev?.acVoltage ?? null) : null;
        rule.acOn = on;
        if (on !== null) attrs.ac = on;
      } else {
        live.doorOpen = on;
        live.doorVoltage = cfg.source === 'ANALOG' ? (reading.voltage ?? prev?.doorVoltage ?? null) : null;
        rule.doorOpen = on;
        if (on !== null) attrs.doorOpen = on;
      }
    }
    position.attributes = attrs;
    return { live, rule };
  }

  /** The tracker reported its SIM ICCID (Concox info packet, Teltonika IO 11/14): keep it on the device for Super Admin. */
  private saveIccid(deviceId: string, iccid: unknown): void {
    if (typeof iccid !== 'string' || !iccid || this.iccidSaved.get(deviceId) === iccid) return;
    this.iccidSaved.set(deviceId, iccid);
    this.prisma.device
      .update({ where: { id: deviceId }, data: { iccid, deviceInfoAt: new Date() } })
      .catch((e: Error) => this.logger.warn(`ICCID for ${deviceId} not saved: ${e.message}`));
  }

  private evaluate(
    position: NormalizedPosition,
    device: ResolvedDevice,
    lives: Map<string, LiveObject>,
    tracks: Map<string, TrackState>,
    changed: Map<string, LiveObject>,
    now: number,
    serverTime: string,
    ruleInputs: RuleInput[],
    fuel: FuelBatch = { states: new Map(), changed: new Set(), events: [] },
    io: IoBatch = emptyIoBatch(),
  ): PositionRow[] {
    // Impossible device times (reset clock, GPS week rollover) would drop live data and alarms as "late".
    position = correctClock(position).position;
    this.saveIccid(device.deviceId, position.attributes?.iccid);
    const fixTime = Date.parse(position.fixTime);
    const object = device.object;
    // Ignition is only wired in vehicles; personal / asset / pet trackers report a meaningless ACC bit, which would
    // otherwise drive status, drift filtering and ignition alerts (seen: an ID card tracker always "ignition off").
    if (object && object.type !== 'VEHICLE' && position.ignition !== null) position = { ...position, ignition: null };
    let flags = 0;
    // Phone trackers only: whether this row is a parked repeat (not stored), see parked-thinning.ts.
    let parked: boolean | null = null;

    // Calibrated fuel level (litres, % of the tank) per the vehicle's fuel settings, stored with the position.
    let litres: number | null = null;
    if (object && device.fuel) {
      litres = fuelLitres(position.attributes ?? {}, device.fuel);
      if (litres !== null) {
        const tank = device.fuel.tankCapacityL;
        const pct = tank ? Math.min(100, Math.round((litres / tank) * 1000) / 10) : null;
        position.attributes = { ...(position.attributes ?? {}), fuelL: litres, ...(pct !== null ? { fuelPct: pct } : {}) };
      }
    }

    if (object) {
      const track = tracks.get(object.objectId) ?? EMPTY_TRACK_STATE;
      const result = filterPosition(
        { ...position, fixTime, accuracyM: numberAttr(position.attributes, 'accuracyM') },
        track,
        { objectType: object.type, thresholds: device.thresholds, now },
      );
      flags = result.flags;
      if (result.updatesLive) {
        const prev = lives.get(object.objectId);
        const prevStatus: StatusState | null =
          prev && prev.statusSince && prev.status !== 'NO_DATA'
            ? { status: prev.status, statusSince: Date.parse(prev.statusSince), stoppedSince: track.stoppedSince }
            : null;
        const status = nextStatus(
          prevStatus,
          { fixTime, speedKph: result.speedKph, ignition: position.ignition },
          device.thresholds,
          object.speedLimitKph ?? Number.POSITIVE_INFINITY,
        );
        const attrs = position.attributes;
        const trusted = (flags & (POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP)) === 0;
        const ioOut = this.applyIo(object, device, position, fixTime, { lat: result.lat, lng: result.lng, trusted }, prev, io);
        const live: LiveObject = {
          ...object,
          status: status.status,
          statusSince: new Date(status.statusSince).toISOString(),
          lat: result.lat,
          lng: result.lng,
          speedKph: result.speedKph,
          course: trusted ? position.course : (prev?.course ?? 0),
          ignition: position.ignition,
          satellites: position.satellites,
          batteryLevel: numberAttr(attrs, 'batteryLevel') ?? prev?.batteryLevel ?? null,
          gsmSignal: numberAttr(attrs, 'gsmSignal') ?? prev?.gsmSignal ?? null,
          extVoltage: numberAttr(attrs, 'extVoltage') ?? prev?.extVoltage ?? null,
          fuelL: device.fuel ? (numberAttr(attrs, 'fuelL') ?? prev?.fuelL ?? null) : null,
          fuelPct: device.fuel ? (numberAttr(attrs, 'fuelPct') ?? prev?.fuelPct ?? null) : null,
          ...ioOut.live,
          fixTime: position.fixTime,
          serverTime,
        };
        lives.set(object.objectId, live);
        if (position.protocol === MOBILE_PROTOCOL) {
          parked = isParkedRepeat({
            speedKph: result.speedKph,
            flags,
            lat: position.lat,
            lng: position.lng,
            accuracyM: numberAttr(attrs, 'accuracyM'),
            fixTime,
            alarm: !!attrs?.alarm,
            statusChanged: prev?.status !== status.status,
            lastValid: track.lastValid,
            storedAt: track.storedAt ?? null,
          });
        }
        tracks.set(object.objectId, { ...result.next, stoppedSince: status.stoppedSince, storedAt: track.storedAt ?? null, heldRow: track.heldRow ?? null });
        changed.set(object.objectId, live);
        const fuelEvents = this.detectFuel(object.objectId, object.companyId, device, litres, fixTime, live, trusted && attrs.reupload !== true, fuel);
        // Vehicles in maintenance (workshop, testing) raise no alerts. Without a GPS fix only location-independent
        // rules run (ignition, SOS/power cut, battery come from the device wiring, not GPS).
        if (!object.inMaintenance) {
          ruleInputs.push({
            object,
            fixTime,
            lat: live.lat ?? Number.NaN,
            lng: live.lng ?? Number.NaN,
            speedKph: live.speedKph,
            ignition: position.ignition,
            attributes: attrs,
            locationValid: (flags & POSITION_FLAGS.INVALID_FIX) === 0 && live.lat !== null && live.lng !== null,
            ...(track.lastValid ? { lastFixAt: track.lastValid.fixTime } : {}),
            receivedAt: now,
            ...(prev?.status === 'OFFLINE' && prev.serverTime ? { offlineSince: Date.parse(prev.serverTime) } : {}),
            ...(fuelEvents.length ? { fuelEvents } : {}),
            ...(ioOut.rule ? { io: ioOut.rule } : {}),
          });
        }
      } else if ((flags & POSITION_FLAGS.FUTURE) !== 0 && !object.inMaintenance) {
        // Dropped from live state because the device clock runs ahead: still tell the operator why.
        ruleInputs.push({
          object,
          fixTime,
          lat: position.lat ?? Number.NaN,
          lng: position.lng ?? Number.NaN,
          speedKph: position.speedKph,
          ignition: position.ignition,
          attributes: position.attributes,
          locationValid: (flags & POSITION_FLAGS.INVALID_FIX) === 0,
          receivedAt: now,
          healthOnly: true,
        });
      } else if (position.attributes?.alarm && position.attributes.reupload !== true && !object.inMaintenance) {
        // LATE: dated before the last point (e.g. a GT06 alarm packet stamped with its last GPS fix while indoors). It
        // must not move live state, but an SOS / power cut / tamper in it is real and still alerts.
        const ownFix = (flags & POSITION_FLAGS.INVALID_FIX) === 0;
        ruleInputs.push({
          object,
          fixTime,
          lat: ownFix ? position.lat : (result.lat ?? Number.NaN),
          lng: ownFix ? position.lng : (result.lng ?? Number.NaN),
          speedKph: position.speedKph,
          ignition: position.ignition,
          attributes: position.attributes,
          locationValid: ownFix,
          ...(!ownFix && track.lastValid ? { lastFixAt: track.lastValid.fixTime } : {}),
          receivedAt: now,
          alarmsOnly: true,
        });
      }
    }

    const row: PositionRow = {
      objectId: object?.objectId ?? null,
      deviceId: device.deviceId,
      fixTime: position.fixTime,
      serverTime,
      lat: position.lat,
      lng: position.lng,
      speedKph: position.speedKph,
      course: position.course,
      altitude: position.altitude,
      satellites: position.satellites,
      valid: position.valid,
      ignition: position.ignition,
      flags,
      attributes: JSON.stringify(position.attributes ?? {}),
    };
    if (parked === null || !object) return [row];
    const t = tracks.get(object.objectId)!;
    if (parked) {
      tracks.set(object.objectId, { ...t, heldRow: row });
      return [];
    }
    // Stored: write the last skipped parked point first, so a departure keeps its exact time.
    const held = t.heldRow as PositionRow | null | undefined;
    tracks.set(object.objectId, { ...t, storedAt: fixTime, heldRow: null });
    return held ? [held, row] : [row];
  }

  /** Run the refill / drain detector on a trusted live point; detected events become FuelEvent rows and rule input. */
  private detectFuel(
    objectId: string,
    companyId: string,
    device: ResolvedDevice,
    litres: number | null,
    fixTime: number,
    live: LiveObject,
    usable: boolean,
    fuel: FuelBatch,
  ): NonNullable<RuleInput['fuelEvents']> {
    const state = fuel.states.get(objectId);
    if (!device.fuel || litres === null || !usable || !state) return [];
    const event = stepFuel(state, { t: fixTime, litres, speedKph: live.speedKph, lat: live.lat, lng: live.lng }, device.fuel);
    fuel.changed.add(objectId);
    if (!event) return [];
    const row: FuelEventRow = {
      id: randomUUID(),
      companyId,
      objectId,
      type: event.type,
      startTime: new Date(event.startTime).toISOString(),
      endTime: new Date(event.endTime).toISOString(),
      litresBefore: event.litresBefore,
      litresAfter: event.litresAfter,
      deltaL: event.deltaL,
      lat: event.lat,
      lng: event.lng,
    };
    fuel.events.push(row);
    return [{ ...event, id: row.id }];
  }

  /** Alert rules never block position processing: failures are logged and the batch continues without alerts. */
  private async evaluateRules(inputs: RuleInput[]): Promise<RulesBatch | null> {
    if (!this.rules || !inputs.length) return null;
    try {
      return await this.rules.evaluate(inputs);
    } catch (error) {
      this.logger.error(`Rules evaluation failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async commitRules(rules: RulesBatch): Promise<void> {
    const started = performance.now();
    try {
      await rules.commit();
    } catch (error) {
      this.logger.error(`Rules commit failed: ${(error as Error).message}`);
    }
    this.rules?.recordCommit(performance.now() - started);
  }

  private rawPacket(position: NormalizedPosition, remote: string | null): RawPacketRow {
    return {
      uniqueId: position.uniqueId,
      protocol: position.protocol,
      remoteAddress: remote,
      receivedAt: position.receivedAt,
      hex: position.raw ?? '',
    };
  }

  private trackLastSeen(deviceId: string, now: number, serverTime: string, batch: WriteBatch): void {
    const last = this.lastSeenWritten.get(deviceId) ?? 0;
    if (now - last < LAST_SEEN_THROTTLE_MS) return;
    this.lastSeenWritten.set(deviceId, now);
    batch.lastSeen.push({ deviceId, at: serverTime });
  }

  /** `vehicle.status_changed` webhooks for objects whose coarse state (moving / idle / stopped / offline) changed. */
  private async emitStatusChanges(changed: Map<string, LiveObject>, before: Map<string, LiveObject['status']>): Promise<void> {
    const events: WebhookEventMessage[] = [];
    for (const [objectId, live] of changed) {
      const prev = vehicleState(before.get(objectId));
      const next = vehicleState(live.status);
      if (!prev || !next || prev === next) continue;
      events.push(statusChangedEvent(live, before.get(objectId)!));
    }
    if (!events.length) return;
    try {
      await this.webhooks!.publish(events);
    } catch (error) {
      this.logger.error(`Webhook events failed: ${(error as Error).message}`);
    }
  }

  /** Live state + realtime publish for the latest update of each changed object in this batch. */
  private async publish(changed: Map<string, LiveObject>, tracks: Map<string, TrackState>): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const [objectId, live] of changed) {
      pipeline.set(RedisKeys.live(objectId), JSON.stringify(live));
      pipeline.set(RedisKeys.track(objectId), JSON.stringify(tracks.get(objectId)));
      pipeline.sadd(RedisKeys.liveCompany(live.companyId), objectId);
      pipeline.publish(RedisKeys.liveUpdates, JSON.stringify({ companyId: live.companyId, live }));
    }
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) this.logger.error(`Live state update failed: ${failed[0].message}`);
  }
}
