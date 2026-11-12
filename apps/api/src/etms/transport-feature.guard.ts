import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { AuthContext, AuthedRequest } from '../access/auth-context';
import { customerContextOf } from '../access/transport-scope';

/** Server-wide kill switch: ETMS=off hides every ETMS route (doc 15 §9.4 rollback = switch off). */
export const etmsServerEnabled = (): boolean => (process.env.ETMS ?? '').trim().toLowerCase() !== 'off';

/**
 * ETMS E4 planning / optimisation / routing worker switch (doc 17 §7): off unless ETMS_ROUTING is exactly `on`, and only
 * while ETMS itself is on. Company add-on `etms` still applies per request (TransportFeatureGuard).
 */
export const etmsRoutingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.ETMS ?? '').trim().toLowerCase() !== 'off' && (env.ETMS_ROUTING ?? '').trim().toLowerCase() === 'on';

/**
 * On every ETMS controller (doc 05 §1 "Feature gate"): plain 404 when ETMS is switched off on the server or the acting
 * company's add-on `etms` is off. Complements the menu gating in PermissionGuard for routes guarded by relationship
 * guards rather than menus (E3+).
 * E1b: also applies the customer context (header X-Transport-Customer, doc 07 §2.5) to the request's AuthContext: an
 * id the caller may not act for is a 404 before the handler runs; a valid one narrows ctx.agreements for every helper.
 */
@Injectable()
export class TransportFeatureGuard implements CanActivate {
  /**
   * Whether the route is hidden for this caller. Also read by the global PermissionGuard (which runs first) so an ETMS
   * route guarded by a fleet menu (objects / drivers) is a 404, not a 403, in a company without the add-on.
   */
  static hiddenFor(ctx: Pick<AuthContext, 'features'> | undefined): boolean {
    return !etmsServerEnabled() || !ctx?.features?.includes('etms');
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (TransportFeatureGuard.hiddenFor(req.auth)) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    const narrowed = req.auth ? customerContextOf(req.auth, req.headers?.['x-transport-customer']) : null;
    if (narrowed && req.auth) Object.assign(req.auth, narrowed);
    return true;
  }
}
