import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiScope, cappedKeyRates } from '@veetracer/shared';
import { Response } from 'express';
import { AuthedRequest } from '../access/auth-context';
import { Public } from '../access/decorators';
import { ApiAccessService } from '../licences/api-access.service';
import { RedisService } from '../redis/redis.service';
import { hasScope, looksLikeApiKey } from './api-key-crypto';
import { ApiKeysService } from './api-keys.service';
import { ApiRateLimiter } from './rate-limit';

export const API_SCOPE_META = 'vt:apiScope';

/** Scope a public API route needs. Routes without one are refused (fail closed). */
export const RequireScope = (scope: ApiScope) => SetMetadata(API_SCOPE_META, scope);

/**
 * Public API v1 controller: user sign-in (JWT) is skipped and an API key is required instead.
 * The JWT guard rejects `vtx_` keys on every other route, so the two never mix.
 */
export const ApiKeyController = () => applyDecorators(Public(), UseGuards(ApiKeyGuard));

export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSec: number, message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly limiter: ApiRateLimiter;

  constructor(
    private readonly reflector: Reflector,
    private readonly keys: ApiKeysService,
    redis: RedisService,
    @Optional() private readonly access?: ApiAccessService,
  ) {
    this.limiter = new ApiRateLimiter(redis.client);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const scope = this.reflector.getAllAndOverride<ApiScope | undefined>(API_SCOPE_META, [context.getHandler(), context.getClass()]);
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing API key (Authorization: Bearer vtx_live_…)');
    const token = header.slice(7).trim();
    if (!looksLikeApiKey(token)) throw new UnauthorizedException('The public API only accepts API keys, not user sign-in tokens');
    const ip = req.ip ?? null;
    const key = await this.keys.verify(token, ip);

    // Developer API licence: keys work only while the company's API_ACCESS seat is active or in grace (402 otherwise);
    // the plan caps each key's rates and the company's requests per day. Platform companies have no plan limits.
    const licence = this.access ? await this.access.assertAllowed(key.companyId) : null;
    const { perMinute, perDay } = cappedKeyRates(key, licence?.limits ?? null);
    const rate = await this.limiter.hit(key.id, perMinute, perDay);
    res.setHeader('X-RateLimit-Limit', String(rate.limitMinute));
    res.setHeader('X-RateLimit-Remaining', String(rate.remainingMinute));
    res.setHeader('X-RateLimit-Limit-Day', String(rate.limitDay));
    res.setHeader('X-RateLimit-Remaining-Day', String(rate.remainingDay));
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      throw new RateLimitedException(rate.retryAfterSec, `Rate limit exceeded; retry in ${rate.retryAfterSec} s`);
    }
    if (this.access && licence?.limits) {
      const quota = await this.access.hitCompanyQuota(key.companyId, licence.limits.ratePerDay);
      res.setHeader('X-Quota-Limit-Day', String(licence.limits.ratePerDay));
      res.setHeader('X-Quota-Remaining-Day', String(quota.remaining));
      if (!quota.allowed) {
        res.setHeader('Retry-After', String(quota.retryAfterSec));
        throw new RateLimitedException(quota.retryAfterSec, `Daily request limit of your Developer API plan (${licence.limits.ratePerDay}) reached; retry in ${quota.retryAfterSec} s`);
      }
    }
    this.keys.recordUse(key.id, ip);

    if (!scope) throw new ForbiddenException('This endpoint is not available to API keys');
    if (!hasScope(key.scopes, scope)) throw new ForbiddenException(`This API key lacks the "${scope}" scope`);
    req.auth = this.keys.contextFor(key, ip);
    return true;
  }
}
