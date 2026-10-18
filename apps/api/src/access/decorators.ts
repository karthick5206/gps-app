import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Action, MenuKey } from '@veetracer/shared';
import { AuthContext, AuthedRequest } from './auth-context';

export const IS_PUBLIC = 'vt:isPublic';
export const REQUIRED_PERMISSIONS = 'vt:requiredPermissions';

export type Grant = readonly [MenuKey, Action];

/** Skip authentication (login, OTP, refresh, password reset). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Require `action` on `menu`. A CSV export (`?format=csv`) additionally requires `export` on that menu. */
export const RequirePermission = (menu: MenuKey, action: Action) =>
  SetMetadata(REQUIRED_PERMISSIONS, [[menu, action]] satisfies Grant[]);

/** Allow the request when any one of the grants is held. */
export const RequireAnyPermission = (...grants: Grant[]) => SetMetadata(REQUIRED_PERMISSIONS, grants);

/** The caller's AuthContext (only on authenticated routes). */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});
