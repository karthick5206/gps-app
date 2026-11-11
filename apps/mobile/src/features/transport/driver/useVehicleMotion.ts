import { useEffect, useState } from 'react';
import { INITIAL_MOTION, nextMotion, RELEASE_MS, type MotionState } from '../motion';

/**
 * In-motion state from the BOUND VEHICLE's speed reported by the server (doc 09 §5.1; the phone's own location is
 * never used, D4 / policy phoneLocation NOT_USED). `sample` null = no speed known: not locked, and the screen says the
 * lock is inactive. The driver API contract (transport-driver.ts) does not carry the vehicle speed yet, so callers pass
 * whatever the trip detail offers (see DriverTripScreen).
 */
export function useVehicleMotion(sample: { speedKph: number | null; fixAt: string | null } | null): MotionState {
  const [motion, setMotion] = useState<MotionState>(INITIAL_MOTION);
  const speed = sample?.speedKph ?? null;
  const fixAt = sample?.fixAt ? Date.parse(sample.fixAt) : null;
  useEffect(() => {
    setMotion((m) => nextMotion(m, speed, fixAt, Date.now()));
    // Re-evaluate for the release timer and for staleness while no new sample arrives.
    const id = setInterval(() => setMotion((m) => nextMotion(m, speed, fixAt, Date.now())), RELEASE_MS / 2);
    return () => clearInterval(id);
  }, [speed, fixAt]);
  return motion;
}
