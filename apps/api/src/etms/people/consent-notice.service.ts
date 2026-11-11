import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CONSENT_PURPOSES, type ConsentNoticeDto, type ConsentNoticesDto, type ConsentPurpose } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PublishConsentNoticeDto } from './people.dto';

export const NOTICE_ENTITY = 'TransportConsentNotice';

export interface NoticeRow {
  id: string;
  companyId: string;
  purpose: string;
  seq: number;
  version: string;
  title: string;
  body: string;
  locale: string;
  effectiveFrom: Date;
  createdById: string | null;
  createdAt: Date;
}

/** The notice in force for a purpose at `now`: highest seq whose effectiveFrom has passed (rows of one company). */
export function pickCurrentNotice<T extends Pick<NoticeRow, 'purpose' | 'seq' | 'effectiveFrom'>>(rows: T[], purpose: string, now: number = Date.now()): T | null {
  let best: T | null = null;
  for (const r of rows) if (r.purpose === purpose && r.effectiveFrom.getTime() <= now && (!best || r.seq > best.seq)) best = r;
  return best;
}

/** A published version not yet in force (highest seq with a future effectiveFrom), or null. */
export function pickScheduledNotice<T extends Pick<NoticeRow, 'purpose' | 'seq' | 'effectiveFrom'>>(rows: T[], purpose: string, now: number = Date.now()): T | null {
  let best: T | null = null;
  for (const r of rows) if (r.purpose === purpose && r.effectiveFrom.getTime() > now && (!best || r.seq > best.seq)) best = r;
  return best;
}

export const noticeVersionOf = (seq: number): string => `v${seq}`;

/** Collapse whitespace at the ends and runs of blank lines; keep the paragraph breaks the admin typed. */
export function cleanNoticeBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Company-level, versioned consent notices (doc 10 §4.2; E2 gap 2). Rows are immutable: an edit publishes the next
 * version, so every consent row (noticeVersion) keeps pointing at the exact text the person read. Read by the corporate
 * admin / dispatcher (settings, consent panel) and by the passenger (before granting); published only by a whole-company
 * role with Transport settings edit.
 */
@Injectable()
export class ConsentNoticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private rows(companyId: string): Promise<NoticeRow[]> {
    return this.prisma.transportConsentNotice.findMany({ where: { companyId }, orderBy: [{ purpose: 'asc' }, { seq: 'desc' }] });
  }

  /** The notice in force for one purpose of a company, or null when none is published / in force yet. */
  async current(companyId: string, purpose: string, now: number = Date.now()): Promise<NoticeRow | null> {
    return pickCurrentNotice(await this.rows(companyId), purpose, now);
  }

  /** Current notice of every purpose of the caller's company (passenger view: what they are asked to agree to). */
  async currentAll(companyId: string, now: number = Date.now()): Promise<{ purpose: ConsentPurpose; notice: ConsentNoticeDto | null }[]> {
    const rows = await this.rows(companyId);
    const names = await this.names(rows);
    return CONSENT_PURPOSES.map((purpose) => {
      const n = pickCurrentNotice(rows, purpose, now);
      return { purpose, notice: n ? toNoticeDto(n, names) : null };
    });
  }

  /** Settings view: current and scheduled notice per purpose plus every version (newest first). */
  async list(ctx: Pick<AuthContext, 'companyId'>, now: number = Date.now()): Promise<ConsentNoticesDto> {
    const rows = await this.rows(ctx.companyId);
    const names = await this.names(rows);
    return {
      current: CONSENT_PURPOSES.map((purpose) => {
        const n = pickCurrentNotice(rows, purpose, now);
        const s = pickScheduledNotice(rows, purpose, now);
        return { purpose, notice: n ? toNoticeDto(n, names) : null, scheduled: s ? toNoticeDto(s, names) : null };
      }),
      history: [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq).map((r) => toNoticeDto(r, names)),
    };
  }

  /** Publish the next version of a purpose's notice (immutable; audited). */
  async publish(ctx: AuthContext, dto: PublishConsentNoticeDto, now: number = Date.now()): Promise<ConsentNoticeDto> {
    if (ctx.dataScope !== 'COMPANY') throw new ForbiddenException({ message: 'Only whole-company roles can publish the consent notice', code: 'FORBIDDEN_GRANT' });
    const title = dto.title.replace(/\s+/g, ' ').trim();
    const body = cleanNoticeBody(dto.body);
    if (!title || !body) throw new BadRequestException({ message: 'The notice needs a title and a text', code: 'VALIDATION_FAILED' });
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(now);
    if (Number.isNaN(effectiveFrom.getTime())) throw new BadRequestException({ message: 'Invalid effective date', code: 'VALIDATION_FAILED' });
    // A notice cannot take effect in the past: consents already given were given against the older text.
    if (effectiveFrom.getTime() < now - 60_000) throw new BadRequestException({ message: 'The effective date cannot be in the past', code: 'VALIDATION_FAILED' });

    const row = await this.prisma
      .$transaction(async (tx) => {
        const last = await tx.transportConsentNotice.findFirst({ where: { companyId: ctx.companyId, purpose: dto.purpose }, orderBy: { seq: 'desc' }, select: { seq: true } });
        const seq = (last?.seq ?? 0) + 1;
        const created = await tx.transportConsentNotice.create({
          data: { companyId: ctx.companyId, purpose: dto.purpose, seq, version: noticeVersionOf(seq), title, body, locale: dto.locale?.trim() || 'en', effectiveFrom, createdById: ctx.userId },
        });
        await this.audit.record(
          ctx,
          { action: 'CREATE', entity: NOTICE_ENTITY, entityId: created.id, after: { purpose: created.purpose, version: created.version, title: created.title, locale: created.locale, effectiveFrom: created.effectiveFrom, bodyLength: body.length } },
          tx,
        );
        return created;
      })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ message: 'Someone published this notice at the same time. Reload and try again.', code: 'CONFLICT' });
        throw e;
      });
    return toNoticeDto(row, await this.names([row]));
  }

  private async names(rows: Pick<NoticeRow, 'createdById'>[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

export function toNoticeDto(r: NoticeRow, names: Map<string, string> = new Map()): ConsentNoticeDto {
  return {
    id: r.id,
    purpose: r.purpose,
    version: r.version,
    title: r.title,
    body: r.body,
    locale: r.locale,
    effectiveFrom: r.effectiveFrom.toISOString(),
    createdAt: r.createdAt.toISOString(),
    createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
  };
}
