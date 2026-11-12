import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException, Optional, SetMetadata } from '@nestjs/common';
import { requireSupportReason } from '../access/access-reason';
import { AuthContext, AuthedRequest } from '../access/auth-context';
import { customerContextOf } from '../access/transport-scope';
import { AuditService } from '../audit/audit.service';

/** Server-wide kill switch: ETMS=off hides every ETMS route (doc 15 §9.4 rollback = switch off). */
export const etmsServerEnabled = (): boolean => (process.env.ETMS ?? '').trim().toLowerCase() !== 'off';

/**
 * ETMS E4 planning / optimisation / routing worker switch (doc 17 §7): off unless ETMS_ROUTING is exactly `on`, and only
 * while ETMS itself is on. Company add-on `etms` still applies per request (TransportFeatureGuard).
 */
export const etmsRoutingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.ETMS ?? '').trim().toLowerCase() !== 'off' && (env.ETMS_ROUTING ?? '').trim().toLowerCase() === 'on';

/**
 * QA B1 (safety): routes that the customer picker must NEVER narrow (the SOS / incident lane, banner, bell and siren):
 * X-Transport-Customer is ignored there, so a provider dispatcher looking at customer A still gets customer B's SOS.
 */
export const IGNORES_TRANSPORT_CUSTOMER = 'etms:ignoresTransportCustomer';
export const IgnoresTransportCustomer = () => SetMetadata(IGNORES_TRANSPORT_CUSTOMER, true);

/**
 * Security review M1 / QA follow-up: controllers whose responses carry passenger personal data (names, employee codes,
 * pickup points) of a customer. VeeTrax support (Super Admin) calls them only with X-Access-Reason (400
 * REASON_REQUIRED otherwise, as on /transport/passengers); each such call is written as an ACCESS entry with the reason
 * into the data owner's audit log (its sensitive-access log). Everyone else is unaffected.
 */
export const PASSENGER_DATA = 'etms:passengerData';
export const PassengerData = () => SetMetadata(PASSENGER_DATA, true);
/** Entity / `what` of that ACCESS entry. */
export const TRANSPORT_RECORDS_ENTITY = 'TransportRecords';
export const TRANSPORT_RECORDS_READ = 'transport-records';

function hasMeta(context: ExecutionContext, key: string): boolean {
  const targets = [context.getHandler?.(), context.getClass?.()].filter((t): t is NonNullable<typeof t> => !!t);
  return targets.some((t) => Reflect.getMetadata(key, t) === true);
}

function ignoresCustomer(context: ExecutionContext): boolean {
  return hasMeta(context, IGNORES_TRANSPORT_CUSTOMER);
}

/**
 * On every ETMS controller (doc 05 §1 "Feature gate"): plain 404 when ETMS is switched off on the server or the acting
 * company's add-on `etms` is off. Complements the menu gating in PermissionGuard for routes guarded by relationship
 * guards rather than menus (E3+).
 * E1b: also applies the customer context (header X-Transport-Customer, doc 07 §2.5) to the request's AuthContext: an
 * id the caller may not act for is a 404 before the handler runs; a valid one narrows ctx.agreements for every helper.
 */
@Injectable()
export class TransportFeatureGuard implements CanActivate {
  private readonly logger = new Logger('TransportFeatureGuard');

  constructor(@Optional() private readonly audit?: AuditService) {}

  /**
   * Whether the route is hidden for this caller. Also read by the global PermissionGuard (which runs first) so an ETMS
   * route guarded by a fleet menu (objects / drivers) is a 404, not a 403, in a company without the add-on.
   */
  static hiddenFor(ctx: Pick<AuthContext, 'features'> | undefined): boolean {
    return !etmsServerEnabled() || !ctx?.features?.includes('etms');
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (TransportFeatureGuard.hiddenFor(req.auth)) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    const narrowed = req.auth && !ignoresCustomer(context) ? customerContextOf(req.auth, req.headers?.['x-transport-customer']) : null;
    if (narrowed && req.auth) Object.assign(req.auth, narrowed);
    const auth = req.auth;
    if (auth?.isSuperAdmin && hasMeta(context, PASSENGER_DATA)) {
      // Thrown synchronously (400 REASON_REQUIRED) before the handler runs.
      const reason = requireSupportReason(auth, req.headers?.['x-access-reason']);
      if (this.audit) return this.auditSupport(auth, req, reason).then(() => true);
    }
    return true;
  }

  private async auditSupport(auth: AuthContext, req: AuthedRequest, reason: string | null): Promise<void> {
    const owner = auth.transportCustomerId ?? auth.companyId;
    const route = `${req.method ?? 'GET'} ${String(req.originalUrl ?? req.url ?? '').split('?')[0]}`.slice(0, 200);
    const entry = {
      action: 'ACCESS' as const,
      entity: TRANSPORT_RECORDS_ENTITY,
      details: { what: TRANSPORT_RECORDS_READ, route, superAdmin: true, ...(owner !== auth.companyId ? { actingCompanyId: auth.companyId } : {}), ...(reason ? { reason: reason.slice(0, 300) } : {}) },
    };
    try {
      await this.audit!.recordSystem({ companyId: owner, userId: auth.userId, ip: auth.ip }, entry);
    } catch (error) {
      // Fail closed: no support read of passenger data without its audit entry.
      this.logger.error(`Support access audit failed: ${(error as Error).message}`);
      throw error;
    }
  }
}
