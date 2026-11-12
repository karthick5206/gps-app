/**
 * ETMS E1b part of the tenant-isolation matrix (doc 11 §3.1 / §3.2): fleet allocations under an agreement, the
 * customer-context picker and the customer's sensitive-access log. Declared here, consumed by isolation-matrix.ts and
 * isolation-matrix.spec.ts (resource 'provider': the E2 world plus seedE1b).
 *
 * World (on top of the E2 world, where prov ↔ custA is ACTIVE): prov2 ↔ custB is ACTIVE too ("other"); prov and prov2
 * each own a vehicle, and each agreement has one open allocation (started yesterday). custA's and custB's audit logs
 * each hold one provider read, one VeeTrax-support read and one own-staff read of a passenger.
 */
import { randomUUID } from 'crypto';
import type { TransportAccessLogEntryDto, TransportCustomerContextDto, TransportFleetAllocationDto } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import type { AgreementsController } from '../agreements/agreements.controller';
import type { TransportProviderController } from '../provider/transport-provider.controller';
import type { MatrixRole, Ownership, RoleTable } from './isolation-matrix';
import type { MemoryStore } from './memory-store';

export type E1bResource = 'provider';
export const E1B_RESOURCES: readonly E1bResource[] = ['provider'];

export interface E1bControllers {
  agreements: AgreementsController;
  provider: TransportProviderController;
}

export interface E1bIds {
  agreement: string;
  vehicle: string;
  /** A second vehicle of the same provider, not allocated yet (for create). */
  freeVehicle: string;
  allocation: string;
}

export interface E1bWorld {
  party: E1bIds;
  other: E1bIds;
}

const DAY = 86_400_000;

/** Adds the "other" agreement, a vehicle per provider, an open allocation per agreement and audit rows (see header). */
export function seedE1b(store: MemoryStore, partyAgreementId: string, passengers: { custA: string; custB: string }): E1bWorld {
  const other = store.insert('transportServiceAgreement', {
    providerCompanyId: 'prov2',
    customerCompanyId: 'custB',
    status: 'ACTIVE',
    version: 3,
    validFrom: new Date(Date.now() - 30 * DAY),
    validTo: null,
    grants: ['VIEW_BOOKINGS', 'MANAGE_DISPATCH', 'VIEW_PASSENGER_MINIMAL'],
    siteIds: [],
    dataProfile: 'MINIMAL',
    approvedByCustomerAt: new Date(),
    approvedByProviderAt: new Date(),
    endedAt: null,
  }).id as string;
  const vehicle = (companyId: string) => store.insert('trackedObject', { companyId, branchId: null, type: 'VEHICLE', name: `Bus ${companyId}`, plateNumber: `TN 01 ${companyId.length}`, isActive: true }).id as string;
  const allocation = (agreementId: string, providerCompanyId: string, customerCompanyId: string, objectId: string) =>
    store.insert('transportFleetAllocation', { agreementId, providerCompanyId, customerCompanyId, objectId, driverId: null, validFrom: new Date(Date.now() - DAY), validTo: null, note: null, createdById: null }).id as string;
  const pv = vehicle('prov');
  const p2v = vehicle('prov2');
  const pFree = vehicle('prov');
  const p2Free = vehicle('prov2');
  // Audit rows: a provider read, a support read (reason), an own-staff read, per customer.
  for (const [companyId, provider, passenger] of [['custA', 'prov', passengers.custA], ['custB', 'prov2', passengers.custB]] as const) {
    store.insert('user', { id: `user-${provider}-reader`, companyId: provider, name: `${provider} reader`, isSuperAdmin: false });
    store.insert('auditLog', { companyId, userId: `user-${provider}-reader`, action: 'ACCESS', entity: 'EmployeeTransportProfile', entityId: passenger, changes: { what: 'detail', projection: 'MINIMAL', actingCompanyId: provider }, ip: null, createdAt: new Date() });
    store.insert('auditLog', { companyId, userId: 'user-support', action: 'ACCESS', entity: 'EmployeeTransportProfile', entityId: passenger, changes: { what: 'detail', superAdmin: true, reason: 'ticket 42' }, ip: null, createdAt: new Date() });
    store.insert('auditLog', { companyId, userId: `user-${companyId}-staff`, action: 'ACCESS', entity: 'EmployeeTransportProfile', entityId: passenger, changes: { what: 'detail', projection: 'FULL' }, ip: null, createdAt: new Date() });
    store.insert('user', { id: `user-${companyId}-staff`, companyId, name: `${companyId} staff`, isSuperAdmin: false });
  }
  if (!store.table('user').some((u) => u.id === 'user-support')) store.insert('user', { id: 'user-support', companyId: 'platform', name: 'Support', isSuperAdmin: true });
  return {
    party: { agreement: partyAgreementId, vehicle: pv, freeVehicle: pFree, allocation: allocation(partyAgreementId, 'prov', 'custA', pv) },
    other: { agreement: other, vehicle: p2v, freeVehicle: p2Free, allocation: allocation(other, 'prov2', 'custB', p2v) },
  };
}

export const e1bIds = (w: E1bWorld, own: Ownership): E1bIds =>
  own === 'party' ? w.party : own === 'other' ? w.other : { agreement: randomUUID(), vehicle: randomUUID(), freeVehicle: randomUUID(), allocation: randomUUID() };

export interface E1bEntry {
  route: string;
  invoke(c: E1bControllers, ctx: AuthContext, ids: E1bIds, w: E1bWorld): Promise<unknown>;
  expect: Partial<Record<Ownership, RoleTable>>;
  verify?(result: unknown, role: MatrixRole, own: Ownership, ids: E1bIds, w: E1bWorld): void;
}

const fail = (m: string): never => {
  throw new Error(m);
};

/** Parties read; others 404 (VeeTrax support on the platform reads every agreement, PLAT). */
const FLEET_READ: RoleTable = { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 };
const FLEET_READ_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 404, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 404, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 404 };
/** Only the provider side's admin writes; the customer side and VeeTrax support 403 FORBIDDEN_GRANT. */
const FLEET_WRITE: RoleTable = { customerAdmin: 403, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 403 };
const FLEET_WRITE_OTHER: RoleTable = { customerAdmin: 404, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 404, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 403, superAdminSwitched: 404 };

export const E1B_MATRIX: E1bEntry[] = [
  {
    route: 'GET transport/agreements/:id/fleet',
    invoke: (c, ctx, ids) => c.agreements.fleetList(ctx, ids.agreement),
    expect: { party: FLEET_READ, other: FLEET_READ_OTHER },
    verify: (r, role, own, ids, w) => {
      const rows = r as TransportFleetAllocationDto[];
      if (rows.some((a) => a.agreementId !== ids.agreement)) fail(`${role}: allocation of another agreement`);
      if (own === 'party' && rows.some((a) => a.vehicle?.id === w.other.vehicle)) fail(`${role}: sees prov2's vehicle`);
      const canEnd = rows.some((a) => a.canEnd);
      if (canEnd !== (role === 'providerAdmin')) fail(`${role}: canEnd ${canEnd}`);
    },
  },
  { route: 'GET transport/agreements/:id/fleet-options', invoke: (c, ctx, ids) => c.agreements.fleetOptions(ctx, ids.agreement, {}), expect: { party: FLEET_WRITE, other: FLEET_WRITE_OTHER }, verify: (r, role, _own, _ids, w) => {
    const o = r as { vehicles: { id: string }[] };
    if (o.vehicles.some((v) => v.id === w.other.vehicle)) fail(`${role}: options list another provider's vehicle`);
  } },
  {
    route: 'POST transport/agreements/:id/fleet',
    invoke: (c, ctx, ids) => c.agreements.fleetCreate(ctx, ids.agreement, { objectId: ids.freeVehicle }),
    expect: { party: FLEET_WRITE, other: FLEET_WRITE_OTHER },
    verify: (r, role, _own, ids) => {
      const a = r as TransportFleetAllocationDto;
      if (a.vehicle?.id !== ids.freeVehicle || !a.active) fail(`${role}: created allocation not active for the vehicle`);
    },
  },
  { route: 'POST transport/agreements/:id/fleet/:allocationId/end', invoke: (c, ctx, ids) => c.agreements.fleetEnd(ctx, ids.agreement, ids.allocation), expect: { party: FLEET_WRITE, other: FLEET_WRITE_OTHER } },
  {
    route: 'GET transport/context',
    invoke: (c, ctx) => c.provider.context(ctx),
    expect: { party: { customerAdmin: 200, customerDispatcher: 200, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 200, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 } },
    verify: (r, role) => {
      const d = r as TransportCustomerContextDto;
      const ids = d.customers.map((c) => c.customerCompanyId);
      if (ids.includes('custB')) fail(`${role}: context offers custB (another provider's customer)`);
      if (role.startsWith('provider') && (!ids.includes('custA') || !d.showPicker)) fail(`${role}: provider context lacks custA / picker`);
      if (!role.startsWith('provider') && d.showPicker) fail(`${role}: picker shown to a non-provider`);
    },
  },
  {
    route: 'GET transport/access-log',
    invoke: (c, ctx) => c.provider.accessLog(ctx, { actor: 'all' }),
    expect: { party: { customerAdmin: 200, customerDispatcher: 403, customerPassenger: 403, providerAdmin: 200, providerDispatcher: 403, fleetUser: 403, etmsOffCompany: 404, superAdmin: 200, superAdminSwitched: 200 } },
    verify: (r, role) => {
      const items = (r as { items: TransportAccessLogEntryDto[] }).items;
      if (items.some((e) => e.actorCompanyName === 'Provider Two')) fail(`${role}: sees custB's log`);
      if (role === 'customerAdmin' || role === 'superAdminSwitched') {
        const kinds = new Set(items.map((e) => e.actorKind));
        for (const k of ['PROVIDER', 'SUPPORT', 'OWN'] as const) if (!kinds.has(k)) fail(`${role}: no ${k} entry`);
        if (!items.some((e) => e.actorKind === 'SUPPORT' && e.reason === 'ticket 42')) fail(`${role}: support reason missing`);
        // QA B7: support entries carry no (English) name; the web translates "VeeTrax support".
        if (items.some((e) => e.actorKind === 'SUPPORT' && e.actorName !== null)) fail(`${role}: support entry has an actorName`);
        if (!items.some((e) => e.actorKind === 'PROVIDER' && e.actorCompanyName === 'Provider Co')) fail(`${role}: provider name missing`);
      }
      if (role === 'providerAdmin' && items.length) fail('providerAdmin sees customer reads in its own log');
    },
  },
];
