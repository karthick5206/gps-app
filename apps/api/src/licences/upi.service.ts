import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatInr, licenceLabel, UpiClaimDto, UpiPayInfoDto, upiPayUri } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService, Owner } from './billing.service';
import { LicenceSettingsService } from './licence-settings.service';
import { PurchaseDto } from './licences.dto';

// pdfmake's QR encoder (already a dependency): matrix → rectangles, turned into SVG here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const qrEnc = require('pdfmake/js/qrEnc').default as { measure: (node: { qr: string; fit: number; eccLevel?: string }) => { _canvas: { x: number; y: number; w: number; h: number; color: string }[]; _width: number } };

/** QR code for `text` as standalone SVG markup (black on white, quiet zone included). */
export function qrSvg(text: string, size = 240): string {
  const node = qrEnc.measure({ qr: text, fit: size, eccLevel: 'M' });
  const pad = 12;
  const total = node._width + pad * 2;
  const rects = node._canvas
    .filter((r) => r.color !== '#fff')
    .map((r) => `<rect x="${r.x + pad}" y="${r.y + pad}" width="${r.w}" height="${r.h}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

type ClaimRow = { id: string; method: string; customerNote: string | null; ownerKind: string; ownerId: string; amountPaise: number; utr: string | null; paidOn: string; summary: string; status: string; createdAt: Date; createdById: string | null; decidedAt: Date | null; note: string | null };

/** UPI payments: QR / link for the exact amount, customers' "I've paid" with the UTR, Super Admin confirmation. */
@Injectable()
export class UpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly billing: BillingService,
  ) {}

  async info(amountPaise?: number, note?: string): Promise<UpiPayInfoDto> {
    const s = await this.settings.get();
    const vpa = s.upiId.trim();
    const base: UpiPayInfoDto = { enabled: !!vpa, vpa, payeeName: s.bankAccountName || s.legalName || 'VeeTrax', hasImage: !!s.upiQrFile };
    if (!vpa || !amountPaise) return base;
    const uri = upiPayUri(vpa, base.payeeName, amountPaise, note);
    return { ...base, uri, svg: qrSvg(uri) };
  }

  private summary(dto: PurchaseDto): string {
    const parts = dto.items.filter((i) => i.quantity > 0).map((i) => `${i.quantity} × ${licenceLabel(i.type, i.plan ?? null)}`);
    if (dto.renewSeatIds.length) parts.push(`renew ${dto.renewSeatIds.length} seat(s)`);
    return parts.join(', ');
  }

  /** "I've paid": the amount comes from the server's quote, not the client. */
  async claim(ctx: AuthContext, owner: Owner, dto: PurchaseDto & { method?: 'UPI' | 'CASH'; utr?: string; paidOn: string; customerNote?: string }): Promise<UpiClaimDto> {
    const method = dto.method ?? 'UPI';
    const utr = dto.utr?.trim().toUpperCase() || null;
    if (method === 'UPI') {
      if (!utr || !/^[A-Z0-9]{8,30}$/.test(utr)) throw new BadRequestException('Enter the UPI transaction ID / UTR (12 digits in most apps)');
      if (await this.prisma.upiPaymentClaim.count({ where: { utr, status: { not: 'REJECTED' } } })) throw new ConflictException('This UTR was already submitted');
    }
    const quote = await this.billing.quote(owner, dto);
    const purchase = JSON.parse(JSON.stringify({ items: dto.items, renewSeatIds: dto.renewSeatIds })) as Prisma.InputJsonValue;
    const row = await this.prisma.upiPaymentClaim.create({
      data: { ownerKind: owner.kind, ownerId: owner.id, purchase, amountPaise: quote.gst.totalPaise, method, utr, customerNote: dto.customerNote?.trim() || null, paidOn: dto.paidOn, summary: this.summary(dto), createdById: ctx.userId },
    });
    return (await this.toDtos([row]))[0];
  }

  async list(where: { ownerId?: string; status?: string }): Promise<UpiClaimDto[]> {
    const rows = await this.prisma.upiPaymentClaim.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    return this.toDtos(rows);
  }

  /** Super Admin: the UPI money arrived (UTR seen on the bank statement) → record it like any offline payment. */
  async confirm(ctx: AuthContext, id: string, owner: (kind: string, ownerId: string) => Promise<Owner>) {
    const c = await this.prisma.upiPaymentClaim.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Payment not found');
    if (c.status !== 'PENDING') throw new ConflictException('Already decided');
    const purchase = c.purchase as unknown as PurchaseDto;
    const result = await this.billing.recordOffline(ctx, await owner(c.ownerKind, c.ownerId), { ...purchase, mode: c.method === 'CASH' ? 'CASH' : 'UPI', reference: c.utr ?? undefined, paidOn: c.paidOn, amountPaise: c.amountPaise });
    await this.prisma.upiPaymentClaim.update({ where: { id }, data: { status: 'CONFIRMED', decidedAt: new Date(), decidedById: ctx.userId } });
    return result;
  }

  async reject(ctx: AuthContext, id: string, reason: string): Promise<void> {
    const { count } = await this.prisma.upiPaymentClaim.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', decidedAt: new Date(), decidedById: ctx.userId, note: reason.trim().slice(0, 300) || null } });
    if (!count) throw new ConflictException('Already decided');
  }

  private async toDtos(rows: ClaimRow[]): Promise<UpiClaimDto[]> {
    const companyIds = rows.filter((r) => r.ownerKind === 'COMPANY').map((r) => r.ownerId);
    const partnerIds = rows.filter((r) => r.ownerKind === 'PARTNER').map((r) => r.ownerId);
    const userIds = rows.map((r) => r.createdById).filter((x): x is string => !!x);
    const [companies, partners, users] = await Promise.all([
      companyIds.length ? this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }) : [],
      partnerIds.length ? this.prisma.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    ]);
    const names = new Map([...companies, ...partners].map((x) => [x.id, x.name]));
    const userNames = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      ownerKind: r.ownerKind as 'COMPANY' | 'PARTNER',
      ownerId: r.ownerId,
      ownerName: names.get(r.ownerId) ?? '—',
      amountPaise: r.amountPaise,
      method: r.method === 'CASH' ? 'CASH' : 'UPI',
      utr: r.utr,
      customerNote: r.customerNote,
      paidOn: r.paidOn,
      summary: `${r.summary} · ${formatInr(r.amountPaise)}`,
      status: r.status as UpiClaimDto['status'],
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdById ? (userNames.get(r.createdById) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      note: r.note,
    }));
  }
}
