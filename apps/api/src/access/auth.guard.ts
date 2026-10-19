import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LICENCE_OVERRIDE_HEADER } from '@veetracer/shared';
import { AuthedRequest } from './auth-context';
import { AuthContextService } from './auth-context.service';
import { IS_PUBLIC } from './decorators';

/** Global guard: every route needs a valid Bearer access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly contexts: AuthContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing access token');
    // Customer API keys only work on the public API (/api/v1), never on the app's own endpoints.
    if (header.startsWith('Bearer vtx_')) throw new UnauthorizedException('API keys can only be used with the public API (/api/v1)');
    const companyHeader = req.headers['x-company-id'];
    req.auth = await this.contexts.fromToken(
      header.slice(7),
      typeof companyHeader === 'string' ? companyHeader : undefined,
      req.ip ?? null,
    );
    const override = req.headers[LICENCE_OVERRIDE_HEADER];
    if (req.auth.isSuperAdmin && typeof override === 'string' && override.trim()) {
      try {
        req.auth.licenceOverride = decodeURIComponent(override).slice(0, 300);
      } catch {
        req.auth.licenceOverride = override.slice(0, 300);
      }
    }
    return true;
  }
}
