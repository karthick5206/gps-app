import { NormalizedPosition } from '@veetracer/shared';
import { batteryFromVoltageLevel, Gt06Fix, Gt06Lbs, GT06_ALARMS, Gt06TerminalStatus } from './gt06/codec';

export const GT06_PROTOCOL = 'gt06';

/** Latest terminal status reported on a connection (0x13 heartbeat / alarm packets). */
export interface ConnectionStatus {
  ignition: boolean;
  charging: boolean;
  batteryLevel: number;
  gsmSignal: number;
}

export function connectionStatus(status: Gt06TerminalStatus): ConnectionStatus {
  return {
    ignition: status.ignition,
    charging: status.charging,
    batteryLevel: batteryFromVoltageLevel(status.voltageLevel),
    gsmSignal: status.gsmSignal,
  };
}

export interface FixContext {
  uniqueId: string;
  fix: Gt06Fix;
  lbs: Gt06Lbs;
  /** ACC from the packet itself (0x22), else null to fall back to the connection status. */
  acc: boolean | null;
  status: ConnectionStatus | null;
  extra?: Record<string, unknown>;
  raw: Buffer;
  receivedAt: Date;
}

/** Map a decoded GT06 fix to the protocol-independent position consumed by the processor. */
export function toNormalizedPosition(c: FixContext): NormalizedPosition {
  return {
    protocol: GT06_PROTOCOL,
    uniqueId: c.uniqueId,
    fixTime: c.fix.time.toISOString(),
    receivedAt: c.receivedAt.toISOString(),
    lat: c.fix.lat,
    lng: c.fix.lng,
    speedKph: c.fix.speedKph,
    course: c.fix.course,
    altitude: null,
    satellites: c.fix.satellites,
    valid: c.fix.positioned,
    ignition: c.acc ?? c.status?.ignition ?? null,
    attributes: {
      ...(c.status ? { batteryLevel: c.status.batteryLevel, gsmSignal: c.status.gsmSignal, charging: c.status.charging } : {}),
      mcc: c.lbs.mcc,
      mnc: c.lbs.mnc,
      lac: c.lbs.lac,
      cellId: c.lbs.cellId,
      ...c.extra,
    },
    raw: c.raw.toString('hex'),
  };
}

export const alarmName = (code: number): string => GT06_ALARMS[code] ?? `alarm_${code}`;
