import { BadRequestException, StreamableFile } from '@nestjs/common';
import { ListQuery, Paginated } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CsvColumn, csvFile } from './csv';

export const CSV_MAX_ROWS = 50_000;

/** Query string shared by every master list; entity DTOs extend it with their filters. */
export class ListQueryDto implements ListQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(50) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export interface ListSpec {
  /** Field paths searched case-insensitively by `q` (dot paths for to-one relations), or a custom builder. */
  search: string[] | ((q: string) => object);
  /** Public sort key → field path. */
  sort: Record<string, string>;
  defaultSort: string;
  defaultOrder?: 'asc' | 'desc';
  /** Boolean field filtered by `status` (default `isActive`); custom builder or null to disable. */
  status?: string | ((active: boolean) => object) | null;
  /** Unique field appended to the ordering for stable pages (default `id`). */
  tiebreaker?: string;
}

export interface ListPlan<W, O> {
  where: W;
  orderBy: O[];
  skip: number;
  take: number;
  page: number;
  pageSize: number;
  csv: boolean;
}

function nest(path: string, leaf: unknown): Record<string, unknown> {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>((acc, key) => ({ [key]: acc }), leaf) as Record<string, unknown>;
}

/** Translate the common list query into Prisma `where` / `orderBy` / paging arguments. */
export function planList<W, O>(query: ListQueryDto, spec: ListSpec): ListPlan<W, O> {
  const and: object[] = [];
  const q = query.q?.trim();
  if (q) {
    and.push(
      typeof spec.search === 'function'
        ? spec.search(q)
        : { OR: spec.search.map((path) => nest(path, { contains: q, mode: 'insensitive' })) },
    );
  }
  if (query.status && spec.status !== null) {
    const active = query.status === 'ACTIVE';
    const status = spec.status ?? 'isActive';
    and.push(typeof status === 'function' ? status(active) : { [status]: active });
  }

  const sortKey = query.sort ?? spec.defaultSort;
  const sortPath = spec.sort[sortKey];
  if (!sortPath) throw new BadRequestException(`Unsupported sort field "${sortKey}"`);
  const order = query.order ?? (query.sort ? 'asc' : (spec.defaultOrder ?? 'asc'));
  const tiebreaker = spec.tiebreaker ?? 'id';
  const orderBy = [nest(sortPath, order)];
  if (sortPath !== tiebreaker) orderBy.push({ [tiebreaker]: 'asc' });

  const csv = query.format === 'csv';
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  return {
    where: { AND: and } as W,
    orderBy: orderBy as O[],
    skip: csv ? 0 : (page - 1) * pageSize,
    take: csv ? CSV_MAX_ROWS : pageSize,
    page,
    pageSize,
    csv,
  };
}

export interface CsvSpec<T> {
  name: string;
  columns: CsvColumn<T>[];
}

/** JSON page, or the whole filtered result as a CSV download. */
export function listResult<W, O, T>(
  plan: ListPlan<W, O>,
  items: T[],
  total: number,
  csv: CsvSpec<T>,
): Paginated<T> | StreamableFile {
  if (plan.csv) return csvFile(csv.name, items, csv.columns);
  return { items, total, page: plan.page, pageSize: plan.pageSize };
}
