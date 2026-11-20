import { BadRequestException, Injectable } from '@nestjs/common';
import {
  deviceLicenceType,
  headerKey,
  MOBILE_TRACKER_PROTOCOL,
  normalizeMobile,
  VEHICLE_IMPORT_MAX_ROWS,
  type SeatLicenceType,
  type VehicleImportAction,
  type VehicleImportLicenceSummary,
  type VehicleImportRequest,
  type VehicleImportResult,
} from '@veetracer/shared';
import type { VehicleType } from '@prisma/client';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { randomToken } from '../../common/secrets';
import { LicencePolicyService } from '../../licences/licence-policy.service';
import { LicenceSettingsService } from '../../licences/licence-settings.service';
import { SeatsService } from '../../licences/seats.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { switchDriverTx } from '../../drivers/driver-sessions';
import { stripJt808LeadingZeros } from '../device-unique-id';
import { istDay, istDayEnd, istDayStart, plateKey, planRows, type ExistingDevice, type ExistingVehicle, type ModelRef, type ScopedRow } from './vehicle-import';

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SEATED: VehicleImportAction[] = ['NEW', 'LINK', 'STOCK'];

/**
 * Super Admin "Import vehicles": one sheet (Vehicle name, IMEI, Model, SIM; optional Company, Branch / Location,
 * Vendor, Licence from / until) → devices + vehicles + links (+ vendor links), all in one transaction. Rows without a
 * company / branch use the ones chosen in the dialog. Preview writes nothing. Each device takes a free seat of its
 * company first; the rest get a complimentary (OVERRIDE) seat valid for the row's dates (else the dialog's, else today
 * + overrideDays), with the reason on the seat and in each company's audit log. Unknown vendors are added to the
 * company's Vendors. Re-importing the same sheet skips the rows already there (vendor links are still applied).
 */
@Injectable()
export class VehicleImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly seats: SeatsService,
    private readonly policy: LicencePolicyService,
    private readonly settings: LicenceSettingsService,
  ) {}

  /** Active branches of a company, for the dialog's branch picker. */
  branches(companyId: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.branch.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  async run(ctx: AuthContext, dto: VehicleImportRequest, commit: boolean): Promise<VehicleImportResult> {
    if (!ctx.isSuperAdmin) throw new BadRequestException('Only the Super Admin can import vehicles');
    if (!Array.isArray(dto.rows) || !dto.rows.length) throw new BadRequestException('The sheet has no rows');
    if (dto.rows.length > VEHICLE_IMPORT_MAX_ROWS) throw new BadRequestException(`At most ${VEHICLE_IMPORT_MAX_ROWS} rows per import`);
    const now = new Date();

    // ── company / branch of each row ──
    const companies = await this.prisma.company.findMany({ select: { id: true, name: true } });
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const companyByKey = new Map<string, { id: string; name: string } | null>();
    for (const c of companies) {
      const k = headerKey(c.name);
      companyByKey.set(k, companyByKey.has(k) ? null : c); // null = two companies with the same name
    }
    const dialogCompany = dto.companyId ? companyById.get(dto.companyId) : undefined;
    if (dto.companyId && !dialogCompany) throw new BadRequestException('Unknown company');
    const branches = await this.prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true, companyId: true } });
    const dialogBranch = dto.branchId ? branches.find((b) => b.id === dto.branchId && b.companyId === dto.companyId) : undefined;
    if (dto.branchId && !dialogBranch) throw new BadRequestException('The branch is not in the chosen company');

    const scoped: ScopedRow[] = dto.rows.map((r) => {
      const companyText = String(r.company ?? '').trim();
      const branchText = String(r.branch ?? '').trim();
      let company: { id: string; name: string } | null | undefined = undefined;
      let scopeError: string | null = null;
      if (companyText) {
        company = companyByKey.get(headerKey(companyText));
        if (company === null) scopeError = `More than one company is called "${companyText}"`;
        else if (!company) scopeError = `Company "${companyText}" not found`;
      } else if (dialogCompany) company = dialogCompany;
      else scopeError = 'No company: fill the Company column or choose a company';
      let branch: { id: string; name: string } | null = null;
      if (company && !scopeError) {
        if (branchText) {
          const k = headerKey(branchText);
          branch = branches.find((b) => b.companyId === company!.id && (headerKey(b.name) === k || (b.code && headerKey(b.code) === k))) ?? null;
          if (!branch) scopeError = `Branch "${branchText}" not found in ${company.name}: add it under Branches first`;
        } else if (dialogBranch && company.id === dialogCompany?.id) branch = dialogBranch;
      }
      return { ...r, companyId: company?.id ?? null, companyName: company?.name ?? (companyText || null), branchId: branch?.id ?? null, branchName: branch?.name ?? (branchText || null), scopeError };
    });
    const companyIds = [...new Set(scoped.map((r) => r.companyId).filter((x): x is string => !!x))];

    // ── lookups ──
    const models: ModelRef[] = await this.prisma.deviceModel.findMany({ where: { isActive: true }, select: { id: true, brand: true, model: true, protocol: true, capabilities: true } });
    const defaultModel = dto.defaultModelId ? (models.find((m) => m.id === dto.defaultModelId) ?? null) : null;
    if (dto.defaultModelId && !defaultModel) throw new BadRequestException('Unknown default model');
    const rawImeis = dto.rows.map((r) => String(r.imei ?? '').replace(/\s/g, '')).filter(Boolean);
    const imeis = [...new Set([...rawImeis, ...rawImeis.map((i) => normalizeMobile(i)).filter((x): x is string => !!x), ...rawImeis.map((i) => stripJt808LeadingZeros('jt808', i))])];
    const sims = [...new Set(dto.rows.map((r) => String(r.sim ?? '').replace(/\s/g, '')).filter(Boolean))];
    const [devices, simDevices, vehicles, vendors, drivers] = await Promise.all([
      this.prisma.device.findMany({
        where: { uniqueId: { in: imeis } },
        select: { id: true, uniqueId: true, companyId: true, simNumber: true, company: { select: { name: true } }, assignments: { where: { toTime: null }, select: { object: { select: { id: true, name: true } } } } },
      }),
      sims.length ? this.prisma.device.findMany({ where: { simNumber: { in: sims } }, select: { uniqueId: true, simNumber: true } }) : [],
      this.prisma.trackedObject.findMany({
        where: { companyId: { in: companyIds } },
        select: { id: true, companyId: true, name: true, plateNumber: true, assignments: { where: { toTime: null }, select: { device: { select: { id: true, uniqueId: true } } } } },
      }),
      this.prisma.transportVendor.findMany({ where: { companyId: { in: companyIds } }, select: { id: true, companyId: true, name: true, isActive: true } }),
      this.prisma.driver.findMany({ where: { companyId: { in: companyIds } }, select: { id: true, companyId: true, name: true, mobile: true, isActive: true } }),
    ]);
    const devicesByImei = new Map<string, ExistingDevice>(
      devices.map((d) => [d.uniqueId, { id: d.id, uniqueId: d.uniqueId, companyId: d.companyId, companyName: d.company?.name ?? null, simNumber: d.simNumber, objectId: d.assignments[0]?.object.id ?? null, objectName: d.assignments[0]?.object.name ?? null }]),
    );
    const vehiclesByPlate = new Map<string, ExistingVehicle>();
    for (const v of vehicles) {
      const ev: ExistingVehicle = { id: v.id, name: v.name, plateNumber: v.plateNumber, deviceId: v.assignments[0]?.device.id ?? null, deviceUniqueId: v.assignments[0]?.device.uniqueId ?? null };
      for (const k of [plateKey(v.plateNumber), plateKey(v.name)]) if (k && !vehiclesByPlate.has(`${v.companyId}|${k}`)) vehiclesByPlate.set(`${v.companyId}|${k}`, ev);
    }
    const simOwner = new Map<string, string>(simDevices.filter((d) => d.simNumber).map((d) => [d.simNumber!, d.uniqueId]));

    const overrideDays = (await this.settings.get()).overrideDays;
    const defaultFrom = dto.licenceFrom?.trim() || istDay(now);
    const defaultUntil = dto.licenceUntil?.trim() || istDay(new Date(now.getTime() + overrideDays * DAY_MS));
    if (!DAY.test(defaultFrom) || !DAY.test(defaultUntil)) throw new BadRequestException('Licence dates must be YYYY-MM-DD');
    if (istDayEnd(defaultUntil) <= istDayStart(defaultFrom)) throw new BadRequestException('Licence end date must be after the start date');

    const plans = planRows(scoped, {
      models,
      defaultModel,
      devicesByImei,
      vehiclesByPlate,
      simOwner,
      defaultFrom,
      defaultUntil,
      now,
      normalise: (model, imei) => {
        if (model.protocol !== MOBILE_TRACKER_PROTOCOL) return stripJt808LeadingZeros(model.protocol, imei);
        const mobile = normalizeMobile(imei);
        if (!mobile) throw new Error('Enter the mobile number of the phone (10 digits, or with country code)');
        return mobile;
      },
    });

    // ── vendors: existing by name per company, else added ──
    const vendorKey = (companyId: string, name: string) => `${companyId}|${headerKey(name)}`;
    const vendorByKey = new Map(vendors.map((v) => [vendorKey(v.companyId, v.name), v]));
    const newVendors = new Map<string, { companyId: string; companyName: string; name: string }>();
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const companyId = scoped[i].companyId;
      if (!p.result.vendorName || !companyId || p.result.action === 'ERROR') continue;
      const k = vendorKey(companyId, p.result.vendorName);
      const v = vendorByKey.get(k);
      if (!v) {
        if (!newVendors.has(k)) newVendors.set(k, { companyId, companyName: p.result.companyName ?? '', name: p.result.vendorName });
        p.result.warnings.push(`Vendor "${p.result.vendorName}" is new: it will be added to Vendors`);
      } else if (!v.isActive) p.result.warnings.push(`Vendor "${v.name}" is inactive`);
    }

    // ── drivers: by mobile (last 10 digits), else by a unique name, in the row's company; else added ──
    const last10 = (m: string | null | undefined) => String(m ?? '').replace(/\D/g, '').slice(-10);
    const driverByMobile = new Map<string, (typeof drivers)[number]>();
    const driverByName = new Map<string, (typeof drivers)[number] | null>();
    for (const d of drivers) {
      const m = last10(d.mobile);
      if (m.length === 10 && !driverByMobile.has(`${d.companyId}|${m}`)) driverByMobile.set(`${d.companyId}|${m}`, d);
      const nk = `${d.companyId}|${headerKey(d.name)}`;
      driverByName.set(nk, driverByName.has(nk) ? null : d); // null = two drivers with this name
    }
    type DriverRef = { key: string; id: string | null; companyId: string; branchId: string | null; name: string; mobile: string | null };
    const rowDriver = new Map<number, DriverRef>();
    const newDrivers = new Map<string, DriverRef>();
    const driverRow = new Map<string, number>();
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const sr = scoped[i];
      const name = String(sr.driverName ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const rawMobile = String(sr.driverMobile ?? '').trim();
      if ((!name && !rawMobile) || !sr.companyId || p.result.action === 'ERROR') continue;
      let mobile: string | null = rawMobile ? last10(rawMobile) : null;
      if (mobile && !/^[6-9]\d{9}$/.test(mobile)) {
        p.result.warnings.push(`Driver mobile "${rawMobile}" ignored (not a 10-digit mobile)`);
        mobile = null;
      }
      const byMobile = mobile ? driverByMobile.get(`${sr.companyId}|${mobile}`) : undefined;
      const byName = name ? driverByName.get(`${sr.companyId}|${headerKey(name)}`) : undefined;
      if (!byMobile && byName === null && !mobile) {
        p.result.errors.push(`More than one driver is called "${name}": add the Driver mobile`);
        p.result.action = 'ERROR';
        continue;
      }
      // With a mobile, a different person of the same name is a new driver; without one, the name decides.
      const found = byMobile ?? (mobile ? undefined : (byName ?? undefined));
      if (!found && !name) {
        p.result.warnings.push(`No driver with mobile ${mobile ?? rawMobile} in ${sr.companyName}: add the Driver name to create one`);
        continue;
      }
      const key = found ? found.id : `${sr.companyId}|${mobile ?? headerKey(name)}`;
      const first = driverRow.get(key);
      if (first) {
        p.result.errors.push(`Same driver as row ${first} (a driver drives one vehicle at a time)`);
        p.result.action = 'ERROR';
        continue;
      }
      driverRow.set(key, p.result.row);
      const ref: DriverRef = found
        ? { key, id: found.id, companyId: sr.companyId, branchId: sr.branchId, name: found.name, mobile: found.mobile }
        : { key, id: null, companyId: sr.companyId, branchId: sr.branchId, name, mobile };
      if (found && !found.isActive) p.result.warnings.push(`Driver ${found.name} is inactive`);
      if (!found) {
        newDrivers.set(key, ref);
        p.result.warnings.push(`Driver "${name}" is new: will be added to Drivers`);
      }
      p.result.driverName = ref.name;
      rowDriver.set(i, ref);
    }

    // ── licences per company: free seats per type first, complimentary for the rest ──
    const licences: VehicleImportLicenceSummary[] = [];
    let complimentary = 0;
    for (const companyId of companyIds) {
      const exempt = await this.policy.isExempt(companyId);
      const rows = plans.filter((p, i) => scoped[i].companyId === companyId && SEATED.includes(p.result.action));
      if (!rows.length) continue;
      const neededByType = new Map<SeatLicenceType, number>();
      for (const p of rows) {
        const t = deviceLicenceType(p.model?.capabilities ?? []);
        neededByType.set(t, (neededByType.get(t) ?? 0) + 1);
      }
      let free = 0;
      let comp = 0;
      if (!exempt) {
        for (const [type, n] of neededByType) {
          const f = await this.prisma.licenceSeat.count({ where: { companyId, type, userId: null, deviceId: null, fuelObjectId: null, expiresAt: { gt: now } } });
          free += f;
          comp += Math.max(0, n - f);
        }
      }
      complimentary += comp;
      licences.push({ companyName: companyById.get(companyId)?.name ?? '', needed: exempt ? 0 : rows.length, free, complimentary: comp, exempt });
    }

    const counts = { NEW: 0, LINK: 0, STOCK: 0, SKIP: 0, ERROR: 0 } as Record<VehicleImportAction, number>;
    for (const p of plans) counts[p.result.action]++;
    const result: VehicleImportResult = {
      committed: false,
      rows: plans.map((p) => p.result),
      counts,
      licences,
      complimentary,
      newVendors: [...newVendors.values()].map((v) => `${v.companyName} · ${v.name}`),
      newDrivers: [...newDrivers.values()].map((d) => `${companyById.get(d.companyId)?.name ?? ''} · ${d.name}`),
      licenceFrom: defaultFrom,
      licenceUntil: defaultUntil,
    };
    if (!commit) return result;

    if (counts.ERROR) throw new BadRequestException(`Fix the ${counts.ERROR} row(s) with errors first (or remove them from the sheet)`);
    const reason = dto.overrideReason?.trim() ?? '';
    if (complimentary && reason.length < 3) throw new BadRequestException(`${complimentary} device(s) need a complimentary licence: enter the reason`);
    const seatCtx: AuthContext = { ...ctx, licenceOverride: reason || null };
    const perCompany = new Map<string, { imeis: string[]; complimentary: number; vendors: number; drivers: number }>();
    let overrideSeats = 0;

    await this.prisma.$transaction(
      async (tx) => {
        for (const v of newVendors.values()) {
          const created = await tx.transportVendor.create({ data: { companyId: v.companyId, name: v.name.slice(0, 100) }, select: { id: true, companyId: true, name: true, isActive: true } });
          vendorByKey.set(vendorKey(v.companyId, v.name), created);
        }
        for (const d of newDrivers.values()) {
          d.id = (await tx.driver.create({ data: { companyId: d.companyId, branchId: d.branchId, name: d.name, mobile: d.mobile }, select: { id: true } })).id;
        }
        for (let i = 0; i < plans.length; i++) {
          const p = plans[i];
          const r = p.result;
          const s = scoped[i];
          const companyId = s.companyId!;
          const stats = perCompany.get(companyId) ?? { imeis: [], complimentary: 0, vendors: 0, drivers: 0 };
          perCompany.set(companyId, stats);
          let objectId = p.vehicle?.id ?? null;
          if (SEATED.includes(r.action)) {
            let deviceId: string;
            if (p.device) {
              deviceId = p.device.id; // stock device moves into the company
              await tx.device.update({ where: { id: deviceId }, data: { companyId, isActive: true, ...(r.sim && !p.device.simNumber ? { simNumber: r.sim } : {}) } });
            } else {
              deviceId = (await tx.device.create({ data: { companyId, modelId: p.model!.id, uniqueId: r.imei, simNumber: r.sim, ingestToken: randomToken(24), isActive: true }, select: { id: true } })).id;
            }
            const vehicleType = r.vehicleType as VehicleType;
            if (!objectId) {
              objectId = (await tx.trackedObject.create({ data: { companyId, branchId: s.branchId, type: 'VEHICLE', vehicleType, name: r.vehicleName, plateNumber: r.plate }, select: { id: true } })).id;
            } else {
              // An existing vehicle keeps its type; one without a type gets the sheet's (map icon).
              await tx.trackedObject.updateMany({ where: { id: objectId, vehicleType: null }, data: { vehicleType } });
            }
            await tx.deviceAssignment.create({ data: { deviceId, objectId, fromTime: now } });
            const had = await tx.licenceSeat.findUnique({ where: { deviceId }, select: { id: true } });
            await this.seats.ensureDevice(tx, seatCtx, companyId, deviceId);
            const seat = had ? null : await tx.licenceSeat.findUnique({ where: { deviceId }, select: { id: true, source: true } });
            if (seat?.source === 'OVERRIDE') {
              await tx.licenceSeat.update({
                where: { id: seat.id },
                data: { activatedAt: istDayStart(r.licenceFrom!), expiresAt: istDayEnd(r.licenceUntil!), note: `Override by Super Admin: ${reason.slice(0, 180)} (vehicle import)` },
              });
              stats.complimentary++;
              overrideSeats++;
            }
            stats.imeis.push(r.imei);
          }
          if (r.vendorName && objectId) {
            const vendor = vendorByKey.get(vendorKey(companyId, r.vendorName))!;
            await tx.transportVendorVehicle.deleteMany({ where: { objectId } });
            await tx.transportVendorVehicle.create({ data: { objectId, vendorId: vendor.id, companyId } });
            stats.vendors++;
          }
          const drv = rowDriver.get(i);
          if (drv?.id && objectId) {
            if (await switchDriverTx(tx, { companyId, objectId, driverId: drv.id, at: now, source: 'MANUAL', createdById: ctx.userId })) stats.drivers++;
            if (r.vendorName) {
              const vendor = vendorByKey.get(vendorKey(companyId, r.vendorName))!;
              await tx.transportVendorDriver.deleteMany({ where: { driverId: drv.id } });
              await tx.transportVendorDriver.create({ data: { driverId: drv.id, vendorId: vendor.id, companyId } });
            }
          }
        }
        for (const [companyId, stats] of perCompany) {
          if (!stats.imeis.length && !stats.vendors && !stats.drivers) continue;
          await this.audit.recordFor(
            ctx,
            companyId,
            { action: 'CREATE', entity: 'vehicle_import', entityId: companyId, details: { devices: stats.imeis.length, complimentary: stats.complimentary, vendorLinks: stats.vendors, driverLinks: stats.drivers, reason: reason || null, imeis: stats.imeis } },
            tx,
          );
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    for (const companyId of companyIds) this.policy.invalidate(companyId);
    await this.redis.invalidateCache('device');
    await this.redis.invalidateCache('object');
    return { ...result, committed: true, complimentary: overrideSeats };
  }
}
