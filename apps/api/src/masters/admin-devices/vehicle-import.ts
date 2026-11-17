import { headerKey, parseVehicleType, type VehicleImportAction, type VehicleImportRowInput, type VehicleImportRowResult } from '@veetracer/shared';

/**
 * Pure part of the Super Admin vehicle import: model matching, plate keys, IST day bounds and the per-row plan.
 * The service (vehicle-import.service.ts) loads the lookups and writes.
 */

export const plateKey = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface ModelRef {
  id: string;
  brand: string;
  model: string;
  protocol: string;
  capabilities: string[];
}

/** "Concox V5", "V5", "concox-v5" → the model; brand + model first, then the model name alone when unambiguous. */
export function matchModel(models: ModelRef[], text: string | null | undefined): ModelRef | null {
  const k = headerKey(text);
  if (!k) return null;
  const full = models.filter((m) => headerKey(`${m.brand} ${m.model}`) === k);
  if (full.length === 1) return full[0];
  const short = models.filter((m) => headerKey(m.model) === k);
  return short.length === 1 ? short[0] : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** India-only platform: a licence day starts at 00:00 IST and ends at 23:59:59.999 IST. */
export function istDayStart(day: string): Date {
  if (!DAY.test(day)) throw new Error(`Invalid date ${day}`);
  return new Date(`${day}T00:00:00.000+05:30`);
}
export function istDayEnd(day: string): Date {
  if (!DAY.test(day)) throw new Error(`Invalid date ${day}`);
  return new Date(`${day}T23:59:59.999+05:30`);
}
export function istDay(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export interface ExistingDevice {
  id: string;
  uniqueId: string;
  companyId: string | null;
  companyName: string | null;
  simNumber: string | null;
  /** Current vehicle (open assignment). */
  objectId: string | null;
  objectName: string | null;
}

export interface ExistingVehicle {
  id: string;
  name: string;
  plateNumber: string | null;
  /** Device currently fitted (open assignment). */
  deviceId: string | null;
  deviceUniqueId: string | null;
}

/** A sheet row with its company / branch resolved by the service (scopeError when they could not be). */
export interface ScopedRow extends VehicleImportRowInput {
  companyId: string | null;
  companyName: string | null;
  branchId: string | null;
  branchName: string | null;
  scopeError?: string | null;
}

export interface PlanLookups {
  models: ModelRef[];
  defaultModel: ModelRef | null;
  devicesByImei: Map<string, ExistingDevice>;
  /** Vehicles by `companyId|plateKey` (of the plate number and of the name). */
  vehiclesByPlate: Map<string, ExistingVehicle>;
  /** SIM number → IMEI of the device that has it. */
  simOwner: Map<string, string>;
  /** IMEI normalisation for the model (mobile tracker → phone number); throws a message on a bad value. */
  normalise: (model: ModelRef, imei: string) => string;
  /** Complimentary licence dates for rows without their own (YYYY-MM-DD). */
  defaultFrom: string;
  defaultUntil: string;
  now: Date;
}

export interface RowPlan {
  result: VehicleImportRowResult;
  model: ModelRef | null;
  device: ExistingDevice | null;
  vehicle: ExistingVehicle | null;
}

const clean = (s: string | null | undefined, max = 100) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function planRows(rows: ScopedRow[], l: PlanLookups): RowPlan[] {
  const seenImei = new Map<string, number>();
  const seenPlate = new Map<string, number>();
  const seenSim = new Map<string, number>();
  return rows.map((r) => {
    const vehicleName = clean(r.vehicleName);
    const plate = clean(r.plate, 30) || vehicleName.slice(0, 30);
    const rawImei = clean(r.imei, 40).replace(/\s/g, '');
    const sim = clean(r.sim, 30).replace(/\s/g, '') || null;
    const errors: string[] = [];
    const warnings: string[] = [];
    if (r.scopeError) errors.push(r.scopeError);
    const licenceFrom = clean(r.licenceFrom, 10) || l.defaultFrom;
    const licenceUntil = clean(r.licenceUntil, 10) || l.defaultUntil;
    if (!DAY.test(licenceFrom)) errors.push(`Licence from "${licenceFrom}" is not a date`);
    else if (!DAY.test(licenceUntil)) errors.push(`Licence until "${licenceUntil}" is not a date`);
    else if (istDayEnd(licenceUntil) <= istDayStart(licenceFrom)) errors.push(`Licence until (${licenceUntil}) must be after licence from (${licenceFrom})`);
    else if (istDayEnd(licenceUntil) <= l.now) errors.push(`Licence until (${licenceUntil}) is already over`);
    let model = matchModel(l.models, r.model);
    if (!model && clean(r.model)) {
      if (l.defaultModel) warnings.push(`Model "${clean(r.model)}" not recognised: using ${l.defaultModel.brand} ${l.defaultModel.model}`);
      else errors.push(`Model "${clean(r.model)}" not found: add it under Device models or choose a default model`);
    }
    model ??= l.defaultModel;
    if (!model && !clean(r.model)) errors.push('No model: fill the Model column or choose a default model');
    if (!vehicleName) errors.push('Vehicle name is empty');
    let vehicleType = parseVehicleType(r.vehicleType);
    if (!vehicleType) {
      warnings.push(`Vehicle type "${clean(r.vehicleType, 30)}" not recognised: using Car`);
      vehicleType = 'CAR';
    }
    let imei = rawImei;
    if (!rawImei) errors.push('IMEI is empty');
    else if (model) {
      try {
        imei = l.normalise(model, rawImei);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (imei && !/^[A-Za-z0-9_-]{4,32}$/.test(imei)) errors.push(`IMEI "${imei}" looks wrong (4–32 letters / digits)`);
    if (sim && sim.length > 20) errors.push(`SIM number "${sim}" is longer than 20 characters`);

    if (imei) {
      const first = seenImei.get(imei);
      if (first) errors.push(`Same IMEI as row ${first}`);
      else seenImei.set(imei, r.row);
    }
    const pk = plateKey(plate);
    if (pk) {
      const first = seenPlate.get(pk);
      if (first) errors.push(`Same vehicle as row ${first}`);
      else seenPlate.set(pk, r.row);
    }
    if (sim) {
      const first = seenSim.get(sim);
      if (first) warnings.push(`Same SIM number as row ${first}`);
      else seenSim.set(sim, r.row);
      const owner = l.simOwner.get(sim);
      if (owner && owner !== imei) warnings.push(`SIM ${sim} is already on device ${owner}`);
    }

    const device = imei ? (l.devicesByImei.get(imei) ?? null) : null;
    const vehicle = pk && r.companyId ? (l.vehiclesByPlate.get(`${r.companyId}|${pk}`) ?? null) : null;
    let action: VehicleImportAction = 'NEW';
    if (device) {
      if (device.companyId && device.companyId !== r.companyId) errors.push(`IMEI ${imei} belongs to ${device.companyName ?? 'another company'}`);
      else if (device.companyId === r.companyId) {
        if (vehicle && device.objectId === vehicle.id) action = 'SKIP';
        else if (device.objectId) errors.push(`IMEI ${imei} is already fitted to ${device.objectName ?? 'another vehicle'}`);
        else errors.push(`IMEI ${imei} is already in this company (not fitted): fit it from Vehicles`);
      } else action = 'STOCK';
    }
    if (action !== 'SKIP' && vehicle) {
      if (vehicle.deviceId) errors.push(`${vehicle.name} already has device ${vehicle.deviceUniqueId ?? ''}`.trim());
      else if (action === 'NEW') action = 'LINK';
      if (action === 'STOCK') warnings.push(`Fits to the existing vehicle ${vehicle.name}`);
    }
    if (action === 'SKIP' && sim && device?.simNumber && device.simNumber !== sim) warnings.push(`Already imported; SIM differs (${device.simNumber}) and is not changed`);
    return {
      result: {
        row: r.row,
        vehicleName,
        plate,
        imei,
        sim,
        modelLabel: model ? `${model.brand} ${model.model}` : null,
        companyName: r.companyName,
        branchName: r.branchName,
        vendorName: clean(r.vendor) || null,
        driverName: clean(r.driverName) || (clean(r.driverMobile, 30) || null),
        vehicleType,
        licenceFrom,
        licenceUntil,
        action: errors.length ? 'ERROR' : action,
        errors,
        warnings,
      },
      model,
      device,
      vehicle,
    };
  });
}
