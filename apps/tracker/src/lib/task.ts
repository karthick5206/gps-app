import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { enqueue } from './db';
import { isUsable, readBattery, toPoint } from './points';
import { getToken, store } from './state';
import { LOCATION_TASK, stopUpdates } from './tracking';
import { flush } from './uploader';

/**
 * Background location task. Android delivers fixes here through the foreground service, also when the app
 * is closed (then the JS bundle runs headless). Points go to the local queue, then an upload is attempted.
 */
TaskManager.defineTask<{ locations: LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    store.patchStatus({ lastError: error.message });
    return;
  }
  // Tracking was switched off (or the phone signed out) but the service is still alive: stop it.
  if (!store.wanted() || !(await getToken())) {
    await stopUpdates();
    return;
  }
  const locations = [...(data?.locations ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  if (!locations.length) return;

  const battery = await readBattery();
  let lastT = store.lastT();
  const fresh = [];
  for (const loc of locations) {
    const p = toPoint(loc, battery);
    if (p.t <= lastT) continue; // duplicate or older than what we already have
    lastT = p.t;
    if (isUsable(p)) fresh.push(p);
  }
  store.setLastT(lastT);
  const last = locations[locations.length - 1];
  store.patchStatus({
    lastFixAt: Math.round(last.timestamp),
    lastAcc: last.coords.accuracy,
    lastSpd: last.coords.speed != null && last.coords.speed >= 0 ? last.coords.speed : null,
  });
  if (fresh.length) enqueue(fresh);
  await flush();
});
