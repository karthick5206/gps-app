import { MovementStatus, StatusThresholds } from '@veetracer/shared';

export interface StatusState {
  status: MovementStatus;
  statusSince: number; // epoch ms of the last status change
  stoppedSince: number | null; // epoch ms the object stopped moving, null while moving
}

export interface StatusInput {
  fixTime: number;
  speedKph: number;
  ignition: boolean | null;
}

/** Movement status machine (see M1 spec "Processor" step 3). */
export function nextStatus(
  prev: StatusState | null,
  input: StatusInput,
  thresholds: StatusThresholds,
  speedLimitKph: number,
): StatusState {
  const moving = input.speedKph > thresholds.runningSpeedKph;
  let status: MovementStatus;
  let stoppedSince: number | null;

  if (moving) {
    stoppedSince = null;
    status = input.speedKph > speedLimitKph ? 'OVERSPEED' : 'RUNNING';
  } else {
    stoppedSince = prev?.stoppedSince ?? input.fixTime;
    if (input.ignition === true) {
      const stationaryLongEnough = input.fixTime - stoppedSince >= thresholds.idleAfterSec * 1000;
      const wasMoving = prev?.status === 'RUNNING' || prev?.status === 'OVERSPEED';
      status = wasMoving && !stationaryLongEnough ? prev.status : 'IDLE';
    } else {
      status = 'OFF';
    }
  }

  const statusSince = prev && prev.status === status ? prev.statusSince : input.fixTime;
  return { status, statusSince, stoppedSince };
}
