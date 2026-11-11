import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MENUS, menuAvailable } from '@veetracer/shared';
import { hasPermission } from './access-rules';
import { AuthedRequest } from './auth-context';
import { Grant, REQUIRED_PERMISSIONS } from './decorators';

const MENU_BY_KEY = new Map(MENUS.map((m) => [m.key as string, m]));

/**
 * Global guard enforcing @RequirePermission / @RequireAnyPermission. Runs after JwtAuthGuard.
 * Module menus (MenuDef.requires, e.g. ETMS): when the acting company's add-on is off for every required menu the route
 * answers a plain 404 (doc 05 §4 ETMS_DISABLED is logged, not sent), so a company without the module can't even tell
 * the route exists. A missing grant on a module menu is 403 with code FORBIDDEN_GRANT.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger('PermissionGuard');

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const grants = this.reflector.getAllAndOverride<Grant[] | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!grants?.length) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const ctx = req.auth;
    if (!ctx) throw new ForbiddenException('Permission denied');
    const features = ctx.features ?? [];
    const defs = grants.map(([menu]) => MENU_BY_KEY.get(menu));
    const moduleRoute = defs.some((d) => d?.requires);
    if (moduleRoute && defs.every((d) => d && !menuAvailable(d, features))) {
      this.logger.debug(`ETMS_DISABLED ${req.method} ${req.originalUrl ?? req.url} company=${ctx.companyId}`);
      throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    }
    const csv = req.method === 'GET' && req.query.format === 'csv';
    const allowed = grants.some(
      ([menu, action]) => hasPermission(ctx, menu, action) && (!csv || hasPermission(ctx, menu, 'export')),
    );
    if (!allowed) {
      const message = csv ? 'Export not permitted' : 'Permission denied';
      throw new ForbiddenException(moduleRoute ? { message, code: 'FORBIDDEN_GRANT' } : message);
    }
    return true;
  }
}
