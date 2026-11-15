/**
 * Night-shift escort check (pure, `node --test`): on a draft trip whose first pickup (IN) or last drop (OUT) falls in
 * the company night window, that passenger rides alone with the driver — the desk is told who, so an escort can be
 * arranged or the order changed. Stop times are the draft plan (start + n × gap), as published.
 */
import { inNightWindow, minuteOfDayIn, type NightSafetySettings, type TransportDirection } from '@veetracer/shared';
import { newTripOrder, type DispatchDraft, type DraftNewTrip } from './dispatch-draft.ts';

export interface EscortWarning {
  tempId: string;
  passenger: string;
  /** First pickup (IN) or last drop (OUT). */
  end: 'FIRST_PICKUP' | 'LAST_DROP';
  /** Planned wall time HH:MM. */
  time: string;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function escortWarnings(draft: DispatchDraft, night: NightSafetySettings | null | undefined, timeZone: string): EscortWarning[] {
  if (!night?.on) return [];
  const out: EscortWarning[] = [];
  for (const n of draft.newTrips) {
    const w = tripWarning(n, draft, draft.direction, night, timeZone);
    if (w) out.push(w);
  }
  return out;
}

function tripWarning(n: DraftNewTrip, draft: DispatchDraft, direction: TransportDirection, night: NightSafetySettings, tz: string): EscortWarning | null {
  const order = newTripOrder(n, draft.bookings, direction);
  if (!order.length) return null;
  // IN: the first stop is the first pickup. OUT: the office first, then the drops; the last stop is the last drop.
  const pickups = new Set(order.map((id) => draft.bookings[id]?.pickup && `${draft.bookings[id].pickup!.lat},${draft.bookings[id].pickup!.lng}`)).size;
  const drops = new Set(order.map((id) => draft.bookings[id]?.drop && `${draft.bookings[id].drop!.lat},${draft.bookings[id].drop!.lng}`)).size;
  const atMs = direction === 'IN' ? n.startMs : n.startMs + Math.max(0, pickups + drops - 1) * n.gapMin * 60_000;
  const m = minuteOfDayIn(atMs, tz);
  if (!inNightWindow(m, night.from, night.to)) return null;
  const id = direction === 'IN' ? order[0] : order[order.length - 1];
  return { tempId: n.tempId, passenger: draft.bookings[id]?.name ?? id, end: direction === 'IN' ? 'FIRST_PICKUP' : 'LAST_DROP', time: hhmm(m) };
}
