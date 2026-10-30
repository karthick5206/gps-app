import { Injectable } from '@nestjs/common';
import {
  ALERT_TYPE_MAP,
  parseQuery,
  SEARCH_EXAMPLES,
  searchKey,
  STATUS_META,
  type AlertTypeCode,
  type LiveObject,
  type SearchAnswerDto,
  type SearchCard,
  type SearchLink,
  type SearchTime,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { GeocodingService } from '../geocoding/geocoding.service';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, localDayKey, localMidnight, zonedTimeToUtc } from '../summarizer/tz';

const HOUR = 3_600_000;
const TOP = 10;
/** Intents that are about one vehicle when a vehicle is named. */
const ONE_VEHICLE = new Set(['WHERE', 'STATUS']);

interface Range {
  from: number;
  to: number;
  /** "today", "yesterday", "this week" … for the answer sentence. */
  label: string;
  /** A single moment (WHERE at a time). */
  at?: number;
}

const km = (v: number) => (v >= 100 ? `${Math.round(v).toLocaleString('en-IN')} km` : `${v.toFixed(1)} km`);
const dur = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const plate = (o: Pick<LiveObject, 'name' | 'plateNumber'>) => (o.plateNumber && o.plateNumber !== o.name ? `${o.name} (${o.plateNumber})` : o.name);

/** Local time text in the company zone. */
function clock(ms: number, tz: string, withDate = false): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', ...(withDate ? { day: 'numeric', month: 'short' } : {}) }).format(ms);
}

/** Resolves a question's time in the company zone (default: today so far). */
export function resolveRange(time: SearchTime | null, tz: string, now: number): Range {
  const today = localDayKey(now, tz);
  const dayRange = (day: string, label: string, atMin?: number): Range => {
    const from = localMidnight(day, tz);
    const to = Math.min(now, localMidnight(addDays(day, 1), tz));
    return atMin === undefined ? { from, to, label } : { from, to, label, at: zonedTimeToUtc(day, Math.floor(atMin / 60), atMin % 60, tz) };
  };
  if (!time || time.kind === 'now') return dayRange(today, 'today');
  switch (time.kind) {
    case 'day':
      return dayRange(addDays(today, time.offset), time.offset === 0 ? 'today' : time.offset === -1 ? 'yesterday' : `${-time.offset} days ago`, time.atMin);
    case 'date':
      return dayRange(time.day, `on ${time.day}`, time.atMin);
    case 'week': {
      const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      const monday = addDays(today, -dow + 7 * time.offset);
      return { from: localMidnight(monday, tz), to: Math.min(now, localMidnight(addDays(monday, 7), tz)), label: time.offset === 0 ? 'this week' : 'last week' };
    }
    case 'month': {
      const [y, m] = today.split('-').map(Number);
      const start = new Date(Date.UTC(y, m - 1 + time.offset, 1));
      const next = new Date(Date.UTC(y, m + time.offset, 1));
      const key = (d: Date) => d.toISOString().slice(0, 10);
      return { from: localMidnight(key(start), tz), to: Math.min(now, localMidnight(key(next), tz)), label: time.offset === 0 ? 'this month' : 'last month' };
    }
    case 'lastDays':
      return { from: localMidnight(addDays(today, -(time.days - 1)), tz), to: now, label: `in the last ${time.days} days` };
    case 'lastNight': {
      // 22:00 → 05:00; before 05:00 "last night" is the night in progress.
      // Before 05:00 the night still running started yesterday at 22:00; after 05:00, so did last night.
      const start = zonedTimeToUtc(addDays(today, -1), 22, 0, tz);
      return { from: start, to: Math.min(now, start + 7 * HOUR), label: 'last night' };
    }
  }
}

/**
 * Ask VeeTrax without AI: reads the question (parseQuery), finds the vehicle among the caller's vehicles, resolves the
 * time in the company zone and answers from live state, day summaries, trips, alerts and documents. Only vehicles in
 * the caller's scope (and not licence-locked) are ever used.
 */
@Injectable()
export class SmartSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly geocoder: GeocodingService,
  ) {}

  async ask(ctx: AuthContext, query: string, now = Date.now()): Promise<SearchAnswerDto> {
    const q = query.trim().slice(0, 200);
    const parsed = parseQuery(q, new Date(now).getFullYear());
    const all = (await this.live.snapshot(ctx)).filter((o) => !o.licenceLocked);
    const tz = await this.timezone(ctx);
    const base = { query: q, intent: parsed.intent, links: [] as SearchLink[], cards: [] as SearchCard[] };

    // Vehicle.
    let vehicles = all;
    if (parsed.vehicle) {
      const found = this.match(all, parsed.vehicle);
      if (!found.length) {
        return { ...base, answer: `No vehicle or person matches "${parsed.vehicle}".`, examples: [...SEARCH_EXAMPLES] };
      }
      if (found.length > 1 && ONE_VEHICLE.has(parsed.intent)) {
        return {
          ...base,
          answer: `${found.length} vehicles match "${parsed.vehicle}". Which one?`,
          choices: found.slice(0, 8).map((o) => ({ objectId: o.objectId, label: plate(o), query: q.replace(new RegExp(parsed.vehicle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), o.plateNumber || o.name) })),
        };
      }
      vehicles = found;
    }
    const one = parsed.vehicle && vehicles.length === 1 ? vehicles[0] : null;
    const range = resolveRange(parsed.time, tz, now);
    const ids = vehicles.map((o) => o.objectId);
    const byId = new Map(all.map((o) => [o.objectId, o]));
    const historyLink = (o: LiveObject, r: Range = range): SearchLink => ({ label: 'Open in History', href: `/history?objectId=${o.objectId}&from=${new Date(r.from).toISOString()}&to=${new Date(r.to).toISOString()}` });
    const mapLink = (o: LiveObject): SearchLink => ({ label: 'Open on map', href: `/live?objectId=${o.objectId}` });

    switch (parsed.intent) {
      case 'STATUS':
      case 'WHERE': {
        if (!one) return { ...base, answer: 'Which vehicle? Type its number or name, for example "Where is TN 09 BB 9421".', examples: [...SEARCH_EXAMPLES] };
        if (range.at !== undefined && range.at < now - 60_000) return this.whereAt(base, one, range.at, tz, historyLink(one, { ...range, from: range.at - HOUR, to: range.at + HOUR }));
        const card = await this.locationCard(one, one.lat, one.lng, one.fixTime, null);
        const since = one.statusSince ? ` since ${clock(Date.parse(one.statusSince), tz, true)}` : '';
        const status = STATUS_META[one.status]?.label ?? one.status;
        const stats = (await this.live.dayStats(ctx, now))[one.objectId];
        if (stats) base.cards.push({ kind: 'stats', items: [{ label: 'Today', value: km(stats.distanceKm) }, { label: 'Moving', value: dur(stats.movingSec) }, { label: 'Stops', value: String(stats.stops) }, { label: 'Odometer', value: km(stats.odometerKm) }] });
        if (!card) return { ...base, answer: `${plate(one)} has no location yet.`, links: [mapLink(one)] };
        return {
          ...base,
          answer: `${plate(one)} is ${status.toLowerCase()}${since}${card.address ? ` at ${card.address}` : ''}${one.speedKph > 2 ? `, ${Math.round(one.speedKph)} km/h` : ''}.`,
          cards: [card, ...base.cards],
          links: [mapLink(one), historyLink(one)],
        };
      }
      case 'DISTANCE':
      case 'IDLE':
      case 'OVERSPEED': {
        const days = await this.prisma.dailySummary.findMany({
          where: { objectId: { in: ids }, day: { gte: new Date(`${localDayKey(range.from, tz)}T00:00:00Z`), lte: new Date(`${localDayKey(Math.max(range.from, range.to - 1), tz)}T00:00:00Z`) } },
          select: { objectId: true, day: true, distanceKm: true, idleSec: true, overspeedCount: true, maxSpeedKph: true },
          orderBy: { day: 'asc' },
        });
        if (one && parsed.intent === 'DISTANCE') {
          const total = days.reduce((s, d) => s + d.distanceKm, 0);
          const best = [...days].sort((a, b) => b.distanceKm - a.distanceKm)[0];
          base.cards.push({ kind: 'table', columns: ['Day', 'Distance'], rows: days.map((d) => ({ objectId: one.objectId, cells: [d.day.toISOString().slice(0, 10), km(d.distanceKm)] })) });
          return { ...base, answer: `${plate(one)} drove ${km(total)} ${range.label}${best && days.length > 1 ? ` (most on ${best.day.toISOString().slice(0, 10)}: ${km(best.distanceKm)})` : ''}.`, links: [historyLink(one), { label: 'Distance report', href: '/reports' }] };
        }
        const per = new Map<string, { km: number; idle: number; over: number; max: number }>();
        for (const d of days) {
          const e = per.get(d.objectId) ?? { km: 0, idle: 0, over: 0, max: 0 };
          e.km += d.distanceKm;
          e.idle += d.idleSec;
          e.over += d.overspeedCount;
          e.max = Math.max(e.max, d.maxSpeedKph);
          per.set(d.objectId, e);
        }
        const rows = [...per.entries()].filter(([id]) => byId.has(id));
        if (parsed.intent === 'DISTANCE') {
          rows.sort((a, b) => b[1].km - a[1].km);
          const total = rows.reduce((s, [, e]) => s + e.km, 0);
          base.cards.push({ kind: 'table', columns: ['Vehicle', 'Distance'], rows: rows.slice(0, TOP).map(([id, e]) => ({ objectId: id, cells: [plate(byId.get(id)!), km(e.km)] })) });
          return { ...base, answer: `${rows.length} vehicles drove ${km(total)} ${range.label}${rows[0] ? `; most: ${plate(byId.get(rows[0][0])!)} with ${km(rows[0][1].km)}` : ''}.`, links: [{ label: 'Distance report', href: '/reports' }] };
        }
        if (parsed.intent === 'IDLE') {
          const idle = rows.filter(([, e]) => e.idle > 0).sort((a, b) => b[1].idle - a[1].idle);
          base.cards.push({ kind: 'table', columns: ['Vehicle', 'Idle time'], rows: idle.slice(0, TOP).map(([id, e]) => ({ objectId: id, cells: [plate(byId.get(id)!), dur(e.idle)] })) });
          return { ...base, answer: idle.length ? `${plate(byId.get(idle[0][0])!)} idled the most ${range.label}: ${dur(idle[0][1].idle)}.` : `No idling ${range.label}.`, links: [{ label: 'Idling report', href: '/reports' }] };
        }
        const over = rows.filter(([, e]) => e.over > 0).sort((a, b) => b[1].over - a[1].over);
        base.cards.push({ kind: 'table', columns: ['Vehicle', 'Overspeeds', 'Top speed'], rows: over.slice(0, TOP).map(([id, e]) => ({ objectId: id, cells: [plate(byId.get(id)!), String(e.over), `${Math.round(e.max)} km/h`] })) });
        return { ...base, answer: over.length ? `${over.length} vehicle(s) overspeeded ${range.label}; most: ${plate(byId.get(over[0][0])!)} (${over[0][1].over} times).` : `No overspeeding ${range.label}.`, links: [{ label: 'Over-speed report', href: '/reports' }] };
      }
      case 'OFFLINE': {
        const off = vehicles.filter((o) => o.status === 'OFFLINE' || o.status === 'NO_DATA').sort((a, b) => Date.parse(a.serverTime ?? '0') - Date.parse(b.serverTime ?? '0'));
        base.cards.push({ kind: 'table', columns: ['Vehicle', 'Last data'], rows: off.slice(0, 20).map((o) => ({ objectId: o.objectId, cells: [plate(o), o.serverTime ? clock(Date.parse(o.serverTime), tz, true) : 'never'] })) });
        return { ...base, answer: off.length ? `${off.length} of ${vehicles.length} vehicles are offline.` : 'All vehicles are online.', links: [{ label: 'Open live map (offline)', href: '/live?status=OFFLINE' }] };
      }
      case 'BATTERY': {
        const low = vehicles.filter((o) => o.batteryLevel !== null && o.batteryLevel < 25).sort((a, b) => (a.batteryLevel ?? 0) - (b.batteryLevel ?? 0));
        base.cards.push({ kind: 'table', columns: ['Vehicle', 'Battery'], rows: low.slice(0, 20).map((o) => ({ objectId: o.objectId, cells: [plate(o), `${Math.round(o.batteryLevel!)}%${o.charging ? ' (charging)' : ''}`] })) });
        return { ...base, answer: low.length ? `${low.length} device(s) below 25% battery.` : 'No device has a low battery.' };
      }
      case 'CHARGING': {
        const on = vehicles.filter((o) => o.charging === true && o.type !== 'VEHICLE');
        const cut = vehicles.filter((o) => o.charging === false && o.type === 'VEHICLE');
        base.cards.push({ kind: 'table', columns: ['Vehicle', 'Power'], rows: [...on.map((o) => ({ objectId: o.objectId, cells: [plate(o), `Charging${o.batteryLevel !== null ? ` · ${Math.round(o.batteryLevel)}%` : ''}`] })), ...cut.map((o) => ({ objectId: o.objectId, cells: [plate(o), 'Main power disconnected'] }))] });
        return { ...base, answer: `${on.length} phone(s) / device(s) charging now${cut.length ? `; ${cut.length} vehicle tracker(s) without main power` : ''}.` };
      }
      case 'TRIPS':
      case 'NIGHT': {
        const r = parsed.intent === 'NIGHT' && !parsed.time ? resolveRange({ kind: 'lastNight' }, tz, now) : range;
        const trips = await this.prisma.trip.findMany({ where: { objectId: { in: ids }, startTime: { gte: new Date(r.from), lt: new Date(r.to) } }, orderBy: { startTime: 'asc' }, take: 50 });
        base.cards.push({
          kind: 'table',
          columns: one ? ['Start', 'End', 'Distance', 'Duration'] : ['Vehicle', 'Start', 'Distance'],
          rows: trips.slice(0, 20).map((t) => ({
            objectId: t.objectId,
            cells: one
              ? [clock(t.startTime.getTime(), tz, true), clock(t.endTime.getTime(), tz), km(t.distanceKm), dur(t.durationSec)]
              : [plate(byId.get(t.objectId) ?? one ?? { name: '?', plateNumber: null }), clock(t.startTime.getTime(), tz, true), km(t.distanceKm)],
          })),
        });
        const movers = new Set(trips.map((t) => t.objectId)).size;
        const answer =
          parsed.intent === 'NIGHT'
            ? movers
              ? `${movers} vehicle(s) moved ${r.label} (${trips.length} trip(s)).`
              : `No vehicle moved ${r.label}.`
            : `${one ? plate(one) : `${movers} vehicle(s)`} made ${trips.length} trip(s) ${r.label}, ${km(trips.reduce((s, t) => s + t.distanceKm, 0))} in total.`;
        return { ...base, answer, links: one ? [historyLink(one, r), { label: 'Trips report', href: '/reports' }] : [{ label: 'Trips report', href: '/reports' }] };
      }
      case 'ALERTS': {
        const alerts = await this.prisma.alert.findMany({ where: { objectId: { in: ids }, occurredAt: { gte: new Date(range.from), lt: new Date(range.to) } }, orderBy: { occurredAt: 'desc' }, take: 200, select: { objectId: true, type: true, occurredAt: true, message: true } });
        const counts = new Map<string, number>();
        for (const a of alerts) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
        base.cards.push({ kind: 'stats', items: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => ({ label: ALERT_TYPE_MAP[t as AlertTypeCode]?.label ?? t, value: String(n) })) });
        base.cards.push({ kind: 'table', columns: ['Time', 'Vehicle', 'Alert'], rows: alerts.slice(0, 15).map((a) => ({ objectId: a.objectId, cells: [clock(a.occurredAt.getTime(), tz, true), plate(byId.get(a.objectId) ?? { name: '?', plateNumber: null }), ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type] })) });
        return { ...base, answer: alerts.length ? `${alerts.length} alert(s) ${range.label}${one ? ` for ${plate(one)}` : ''}.` : `No alerts ${range.label}.`, links: [{ label: 'Open alerts', href: one ? `/alerts?objectId=${one.objectId}` : '/alerts' }] };
      }
      case 'DOCUMENTS': {
        const soon = new Date(now + 30 * 24 * HOUR);
        const [docs, services] = await Promise.all([
          this.prisma.document.findMany({ where: { objectId: { in: ids }, expiresOn: { not: null, lte: soon } }, orderBy: { expiresOn: 'asc' }, take: 30, select: { objectId: true, type: true, expiresOn: true } }),
          this.prisma.serviceReminder.findMany({ where: { objectId: { in: ids }, isActive: true, dueAt: { not: null, lte: soon } }, orderBy: { dueAt: 'asc' }, take: 30, select: { objectId: true, title: true, dueAt: true } }),
        ]);
        const rows = [
          ...docs.map((d) => ({ objectId: d.objectId, when: d.expiresOn!.getTime(), cells: [plate(byId.get(d.objectId!) ?? { name: '?', plateNumber: null }), d.type.replace(/_/g, ' ').toLowerCase(), d.expiresOn!.toISOString().slice(0, 10)] })),
          ...services.map((s) => ({ objectId: s.objectId, when: s.dueAt!.getTime(), cells: [plate(byId.get(s.objectId) ?? { name: '?', plateNumber: null }), s.title, s.dueAt!.toISOString().slice(0, 10)] })),
        ].sort((a, b) => a.when - b.when);
        base.cards.push({ kind: 'table', columns: ['Vehicle', 'Item', 'Due'], rows: rows.slice(0, 20).map((r) => ({ objectId: r.objectId, cells: r.cells })) });
        const overdue = rows.filter((r) => r.when < now).length;
        return { ...base, answer: rows.length ? `${rows.length} document(s) / service(s) due within 30 days${overdue ? `, ${overdue} already overdue` : ''}.` : 'Nothing is due in the next 30 days.', links: [{ label: 'Documents & service', href: '/masters/documents' }] };
      }
    }
  }

  /** Vehicles whose plate or name contains the text (spaces / case ignored), or whose plate ends with its digits. */
  private match(all: LiveObject[], text: string): LiveObject[] {
    const key = searchKey(text);
    if (!key) return [];
    const exact = all.filter((o) => searchKey(o.plateNumber) === key || searchKey(o.name) === key || searchKey(o.uniqueId) === key);
    if (exact.length) return exact;
    const digits = /^\d{3,}$/.test(key);
    return all.filter((o) => {
      const p = searchKey(o.plateNumber);
      const n = searchKey(o.name);
      return p.includes(key) || n.includes(key) || (digits && (searchKey(o.uniqueId).endsWith(key) || p.endsWith(key)));
    });
  }

  private async timezone(ctx: AuthContext): Promise<string> {
    const c = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    return c?.timezone ?? 'Asia/Kolkata';
  }

  private async locationCard(o: LiveObject, lat: number | null, lng: number | null, at: string | null, note: string | null): Promise<Extract<SearchCard, { kind: 'location' }> | null> {
    if (lat === null || lng === null) return null;
    const address = await this.geocoder.reverse(lat, lng).catch(() => null);
    return { kind: 'location', objectId: o.objectId, name: o.name, plateNumber: o.plateNumber, lat, lng, at, address, status: STATUS_META[o.status]?.label ?? o.status, speedKph: Math.round(o.speedKph), note };
  }

  /** Position closest before the moment (within 6 h), with its address. */
  private async whereAt(base: Omit<SearchAnswerDto, 'answer'>, o: LiveObject, at: number, tz: string, link: SearchLink): Promise<SearchAnswerDto> {
    // A clean fix first; any stored point if there is none (e.g. a tracker without GPS fixes then).
    const find = (clean: boolean) =>
      this.prisma.position.findFirst({
        where: { objectId: o.objectId, fixTime: { lte: new Date(at), gte: new Date(at - 6 * HOUR) }, ...(clean ? { flags: { equals: 0 } } : {}) },
        orderBy: { fixTime: 'desc' },
        select: { lat: true, lng: true, fixTime: true, speedKph: true },
      });
    const p = (await find(true)) ?? (await find(false));
    if (!p) return { ...base, answer: `No position for ${plate(o)} around ${clock(at, tz, true)}.`, links: [link] };
    const address = await this.geocoder.reverse(p.lat, p.lng).catch(() => null);
    const card: SearchCard = { kind: 'location', objectId: o.objectId, name: o.name, plateNumber: o.plateNumber, lat: p.lat, lng: p.lng, at: p.fixTime.toISOString(), address, status: p.speedKph > 3 ? 'Moving' : 'Stopped', speedKph: Math.round(p.speedKph), note: null };
    return {
      ...base,
      answer: `At ${clock(at, tz, true)}, ${plate(o)} was ${p.speedKph > 3 ? `moving at ${Math.round(p.speedKph)} km/h` : 'stopped'}${address ? ` at ${address}` : ''} (last fix ${clock(p.fixTime.getTime(), tz)}).`,
      cards: [card],
      links: [link],
    };
  }
}
