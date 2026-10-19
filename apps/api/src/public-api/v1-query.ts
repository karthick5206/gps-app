import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const DAY_MS = 86_400_000;
export const POSITIONS_MAX_DAYS = 7;
export const POSITIONS_PAGE_MAX = 5000;
export const POSITIONS_PAGE_DEFAULT = 1000;
export const LIST_MAX_DAYS = 31;
export const LIST_PAGE_MAX = 1000;
export const LIST_PAGE_DEFAULT = 100;

/** Opaque cursor = base64url(JSON [time ms, tiebreaker id]); the next page starts strictly after that row. */
export interface Cursor {
  t: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.t, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && typeof v[1] === 'string' && v[1].length <= 64) {
      return { t: Number(v[0]), id: v[1] };
    }
  } catch {
    /* fall through */
  }
  throw new BadRequestException('Invalid cursor');
}

/** Prisma condition "after the cursor" for an ascending (timeField, idField) order. */
export function afterCursor(c: Cursor | null, timeField: string, idField: string): Record<string, unknown> {
  if (!c) return {};
  const at = new Date(c.t);
  return { OR: [{ [timeField]: { gt: at } }, { [timeField]: at, [idField]: { gt: c.id } }] };
}

/** One page from `limit + 1` rows: the extra row only tells whether there is a next page. */
export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor): { data: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  return { data, nextCursor: more && data.length ? encodeCursor(cursorOf(data[data.length - 1])) : null };
}

/** Validates ISO `from` / `to` (required) with a maximum span. */
export function parseRange(from: string | undefined, to: string | undefined, maxDays: number): { from: Date; to: Date } {
  if (!from || !to) throw new BadRequestException('from and to are required (ISO 8601 date-times, e.g. 2026-10-01T00:00:00Z)');
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) throw new BadRequestException('from and to must be ISO 8601 date-times');
  if (t <= f) throw new BadRequestException('to must be after from');
  if (t - f > maxDays * DAY_MS) throw new BadRequestException(`The range may span at most ${maxDays} days`);
  return { from: new Date(f), to: new Date(t) };
}

export class PageQueryDto {
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(POSITIONS_PAGE_MAX) limit?: number;
}

export class RangeQueryDto extends PageQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class TripsQueryDto extends RangeQueryDto {
  @IsOptional() @IsUUID() vehicleId?: string;
}

export class AlertsQueryDto extends TripsQueryDto {
  @IsOptional() @IsString() @MaxLength(400) type?: string;
}

export class LiveQueryDto {
  /** Comma-separated vehicle ids. */
  @IsOptional() @IsString() @MaxLength(20_000) vehicleIds?: string;
}

export class ReportQueryDto {
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsString() @MaxLength(20_000) vehicleIds?: string;
  @IsOptional() @IsString() @MaxLength(10) period?: string;
}

export const clampLimit = (limit: number | undefined, def: number, max: number) => Math.min(max, Math.max(1, limit ?? def));

export function idList(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = ids.find((id) => !/^[0-9a-f-]{36}$/i.test(id));
  if (bad) throw new BadRequestException(`"${bad}" is not a vehicle id`);
  return ids;
}
