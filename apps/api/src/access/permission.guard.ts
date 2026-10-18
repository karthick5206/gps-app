import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission } from './access-rules';
import { AuthedRequest } from './auth-context';
import { Grant, REQUIRED_PERMISSIONS } from './decorators';

/** Global guard enforcing @RequirePermission / @RequireAnyPermission. Runs after JwtAuthGuard. */
@Injectable()
export class PermissionGuard implements CanActivate {
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
    const csv = req.method === 'GET' && req.query.format === 'csv';
    const allowed = grants.some(
      ([menu, action]) => hasPermission(ctx, menu, action) && (!csv || hasPermission(ctx, menu, 'export')),
    );
    if (!allowed) throw new ForbiddenException(csv ? 'Export not permitted' : 'Permission denied');
    return true;
  }
}
