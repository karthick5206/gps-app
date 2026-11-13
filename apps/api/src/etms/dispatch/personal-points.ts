import { createHash } from 'crypto';
import type { RoutePath } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import type { AuditService } from '../../audit/audit.service';
import type { RedisService } from '../../redis/redis.service';
import { haversineMeters } from '../../tracking/geo';
import { round } from './e3-common';

/**
 * Personal points on ETMS planned stops (E3 security review H1, M1, M2, M5, L1). A planned stop is a passenger's
 * personal point when it carries `profileId` (set by CREATE_TRIP / ADD_STOP since the security fix), or — for rows
 * written before that — when a seat links it as the pickup / drop of a booking end that is not a company place. A stop
 * with `poiId` (a company place) or a v1.8 route stop is never personal.
 */

export interface StopLike {
  id: string;
  seq: number;
  lat: number;
  lng: number;
  profileId?: string | null;
  poiId?: string | null;
}

export interface SeatLink {
  pickupStopId: string | null;
  dropStopId: string | null;
  booking: { profileId: string; pickupPoiId: string | null; dropPoiId: string | null };
}

/** Owner (profile id) of a personal stop; null for a company site / route stop; 'UNKNOWN' for an unlinked ETMS ad-hoc stop. */
export function stopOwner(s: StopLike, seats: SeatLink[], routeTrip: boolean): string | 'UNKNOWN' | null {
  if (s.profileId) return s.profileId;
  if (s.poiId) return null;
  const seat = seats.find((p) => (p.pickupStopId === s.id && !p.booking.pickupPoiId) || (p.dropStopId === s.id && !p.booking.dropPoiId));
  if (seat) return seat.booking.profileId;
  // A route snapshot's stops are company stops; an ad-hoc (door-to-door) stop nobody is linked to may be anyone's home.
  return routeTrip ? null : 'UNKNOWN';
}

/** Metres between two points. */
export const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineMeters(a.lat, a.lng, b.lat, b.lng);

/** True when `p` is within `m` metres of any of `points`. */
export const nearAny = (p: { lat: number; lng: number }, points: { lat: number; lng: number }[], m: number) => points.some((q) => metres(p, q) <= m);

/** A road path rounded to `d` decimals (the 4-decimal view of branch-scoped dispatchers, E2 M3). */
export function roundPath(path: RoutePath, d: number): RoutePath {
  return path.map(([lng, lat]) => [round(lng, d), round(lat, d)] as [number, number]);
}

/** Name of a personal stop in the stored row (no address label: the v1.8 tracker / alerts / reports read this column). */
export const PERSONAL_STOP_NAME = { PICKUP: 'Passenger pickup', DROP: 'Passenger drop' } as const;

const ACCESS_DEDUPE_SEC = 86_400;

/**
 * L1: one ACCESS audit entry per read that returned passengers' personal points (board, trip detail, candidates, plan,
 * group booking answer — v1.15 L2),
 * de-duplicated per user, view, day and set of passengers (Valkey SET NX; when Valkey is down the entry is written
 * anyway). The entry lists at most 50 profile ids and says whether the points were exact (whole-company role).
 */
export async function recordPersonalAccess(
  audit: Pick<AuditService, 'record'>,
  redis: Pick<RedisService, 'client'> | null | undefined,
  ctx: AuthContext,
  view: 'board' | 'trip' | 'candidates' | 'plan' | 'group',
  profileIds: string[],
  precise: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ids = [...new Set(profileIds)].sort();
  if (!ids.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const hash = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 24);
  try {
    const fresh = await redis?.client?.set(`vt:etms:access:${ctx.userId}:${view}:${day}:${precise ? 'p' : 'r'}:${hash}`, '1', 'EX', ACCESS_DEDUPE_SEC, 'NX');
    if (fresh === null) return; // already logged today
  } catch {
    // Valkey down: log every read rather than none.
  }
  await audit.record(ctx, { action: 'ACCESS', entity: 'TransportPersonalPoints', details: { view, profileIds: ids.slice(0, 50), passengers: ids.length, precise, ...extra } });
}
