import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { etmsRoutingEnabled } from '../transport-feature.guard';

/**
 * On every planning controller, next to TransportFeatureGuard (doc 17 §7 "Flags"): plain 404 while `ETMS_ROUTING` is not
 * exactly `on` (default off) or ETMS is off. Read per request. `hiddenFor` is read by the global PermissionGuard (which
 * runs first), so a caller without the menu also gets 404, never 403.
 */
@Injectable()
export class PlanningFeatureGuard implements CanActivate {
  static hiddenFor(): boolean {
    return !etmsRoutingEnabled();
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (PlanningFeatureGuard.hiddenFor()) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    return true;
  }
}
