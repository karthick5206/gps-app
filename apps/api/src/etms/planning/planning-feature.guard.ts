import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext, AuthedRequest } from '../../access/auth-context';
import { routingOffReasonNow } from '../../routing-switch/routing-switch';

/**
 * On every planning controller, next to TransportFeatureGuard (doc 17 §7 "Flags"): plain 404 unless automatic routing is
 * active for the acting company (v1.16): ETMS_ROUTING / ETMS not `off` (env kill switch), the platform switch on
 * (process snapshot, refreshed every few seconds by RoutingSwitchService) and the company's own switch on
 * (AuthContext.autoRouting from Company.settings.etms.autoRouting). `hiddenFor` is read by the global PermissionGuard
 * (which runs first), so a caller without the menu also gets 404, never 403. GET /routing/capabilities is NOT behind
 * this guard: it tells the planner why routing is off.
 */
@Injectable()
export class PlanningFeatureGuard implements CanActivate {
  static hiddenFor(ctx?: Pick<AuthContext, 'autoRouting'>): boolean {
    return routingOffReasonNow(ctx?.autoRouting) !== null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (PlanningFeatureGuard.hiddenFor(req?.auth)) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    return true;
  }
}
