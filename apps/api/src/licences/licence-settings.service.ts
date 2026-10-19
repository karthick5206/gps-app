import { BadRequestException, Injectable } from '@nestjs/common';
import { PlatformBillingSettings } from '@prisma/client';
import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_GST_RATE,
  gstinError,
  InvoicingSettingsDto,
  LICENCE_TYPES,
  LicencePrices,
  LicencePricingDto,
  LicenceType,
  stateByCode,
} from '@veetracer/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROOT } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export const BILLING_DIR = join(APP_ROOT, 'var', 'billing');
const CACHE_MS = 30_000;
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
const MAX_LOGO_BYTES = 1024 * 1024;

export function readPrices(json: unknown): LicencePrices {
  const src = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  return Object.fromEntries(LICENCE_TYPES.map((t) => [t, Math.max(0, Math.round(Number(src[t]) || 0))])) as LicencePrices;
}

export function toInvoicingDto(s: PlatformBillingSettings): InvoicingSettingsDto {
  return {
    legalName: s.legalName,
    addressLines: s.addressLines,
    city: s.city,
    stateCode: s.stateCode,
    pin: s.pin,
    gstin: s.gstin,
    pan: s.pan,
    phone: s.phone,
    email: s.email,
    website: s.website,
    accountsEmail: s.accountsEmail,
    hasLogo: !!s.logoFile,
    sacCode: s.sacCode,
    invoicePrefix: s.invoicePrefix,
    bankName: s.bankName,
    bankAccountName: s.bankAccountName,
    bankAccountNo: s.bankAccountNo,
    bankIfsc: s.bankIfsc,
    bankBranch: s.bankBranch,
    upiId: s.upiId,
    terms: s.terms,
    footerNote: s.footerNote,
  };
}

/** The single PlatformBillingSettings row (created with defaults by the migration; recreated empty if missing). */
@Injectable()
export class LicenceSettingsService {
  private cached: { row: PlatformBillingSettings; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<PlatformBillingSettings> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.row;
    const row =
      (await this.prisma.platformBillingSettings.findUnique({ where: { id: 'default' } })) ??
      (await this.prisma.platformBillingSettings.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} }));
    this.cached = { row, at: Date.now() };
    return row;
  }

  invalidate(): void {
    this.cached = null;
  }

  async graceDays(): Promise<number> {
    return (await this.get()).graceDays ?? DEFAULT_GRACE_DAYS;
  }

  async pricing(): Promise<LicencePricingDto> {
    const s = await this.get();
    return { pricesPaise: readPrices(s.pricesPaise), gstRatePct: s.gstRatePct ?? DEFAULT_GST_RATE, graceDays: s.graceDays, overrideDays: s.overrideDays };
  }

  /** Prices for a buyer: the partner's overrides where set, else the platform price. */
  async pricesFor(partnerId: string | null): Promise<LicencePrices> {
    const base = readPrices((await this.get()).pricesPaise);
    if (!partnerId) return base;
    const partner = await this.prisma.partner.findUnique({ where: { id: partnerId }, select: { pricesPaise: true } });
    const overrides = (partner?.pricesPaise ?? {}) as Record<string, unknown>;
    const out = { ...base };
    for (const t of LICENCE_TYPES) {
      const v = overrides[t];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[t as LicenceType] = Math.round(v);
    }
    return out;
  }

  async updatePricing(dto: LicencePricingDto): Promise<LicencePricingDto> {
    await this.get();
    await this.prisma.platformBillingSettings.update({
      where: { id: 'default' },
      data: { pricesPaise: readPrices(dto.pricesPaise), gstRatePct: dto.gstRatePct, graceDays: dto.graceDays, overrideDays: dto.overrideDays },
    });
    this.invalidate();
    return this.pricing();
  }

  async invoicing(): Promise<InvoicingSettingsDto> {
    return toInvoicingDto(await this.get());
  }

  async updateInvoicing(dto: Omit<InvoicingSettingsDto, 'hasLogo'>): Promise<InvoicingSettingsDto> {
    if (!stateByCode(dto.stateCode)) throw new BadRequestException('Select a valid state');
    if (dto.gstin) {
      const err = gstinError(dto.gstin, dto.stateCode);
      if (err) throw new BadRequestException(err);
    }
    if (!/^[A-Za-z0-9-]{0,16}$/.test(dto.invoicePrefix)) throw new BadRequestException('Invoice prefix: letters, digits and "-" only (max 16)');
    await this.get();
    const { ...data } = dto;
    await this.prisma.platformBillingSettings.update({
      where: { id: 'default' },
      data: { ...data, gstin: dto.gstin.trim().toUpperCase(), pan: dto.pan.trim().toUpperCase(), addressLines: dto.addressLines.map((l) => l.trim()).filter(Boolean) },
    });
    this.invalidate();
    return this.invoicing();
  }

  async setLogo(file: { buffer: Buffer; mimetype: string; size: number } | undefined): Promise<InvoicingSettingsDto> {
    if (!file) throw new BadRequestException('Choose a logo file');
    const ext = LOGO_TYPES[file.mimetype];
    if (!ext) throw new BadRequestException('Logo must be PNG, JPG or SVG');
    if (file.size > MAX_LOGO_BYTES) throw new BadRequestException('Logo must be 1 MB or smaller');
    if (ext === 'svg' && /<script|on\w+\s*=|javascript:/i.test(file.buffer.toString('utf8'))) throw new BadRequestException('SVG logo must not contain scripts');
    const before = await this.get();
    await mkdir(BILLING_DIR, { recursive: true });
    const name = `logo-${Date.now()}.${ext}`;
    await writeFile(join(BILLING_DIR, name), file.buffer);
    await this.prisma.platformBillingSettings.update({ where: { id: 'default' }, data: { logoFile: name } });
    if (before.logoFile) await unlink(join(BILLING_DIR, before.logoFile)).catch(() => undefined);
    this.invalidate();
    return this.invoicing();
  }

  async removeLogo(): Promise<InvoicingSettingsDto> {
    const before = await this.get();
    await this.prisma.platformBillingSettings.update({ where: { id: 'default' }, data: { logoFile: null } });
    if (before.logoFile) await unlink(join(BILLING_DIR, before.logoFile)).catch(() => undefined);
    this.invalidate();
    return this.invoicing();
  }

  /** The logo file (for the PDF and the settings preview), or null. */
  async logo(): Promise<{ data: Buffer; mime: string } | null> {
    const s = await this.get();
    if (!s.logoFile) return null;
    const path = join(BILLING_DIR, s.logoFile);
    if (!existsSync(path)) return null;
    const ext = s.logoFile.split('.').pop();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return { data: await readFile(path), mime };
  }
}
