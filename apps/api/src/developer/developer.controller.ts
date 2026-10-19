import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { API_SCOPES, ApiScope, WEBHOOK_EVENTS, WebhookEvent } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { WebhooksAdminService, toDeliveryDto } from '../webhooks/webhooks-admin.service';
import { ApiKeysService } from './api-keys.service';

class CreateApiKeyDto {
  @IsString() @Length(1, 80) name!: string;
  @IsArray() @ArrayMaxSize(20) @IsIn(API_SCOPES, { each: true }) scopes!: ApiScope[];
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(64, { each: true }) ipAllowList?: string[];
  @IsOptional() @IsISO8601() expiresAt?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(600) ratePerMinute?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200_000) ratePerDay?: number;
}

export class WebhookEndpointDtoIn {
  @IsString() @Length(1, 80) name!: string;
  @IsString() @Length(8, 2000) url!: string;
  @IsArray() @ArrayMaxSize(20) @IsIn(WEBHOOK_EVENTS, { each: true }) events!: WebhookEvent[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateWebhookDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(8, 2000) url?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(WEBHOOK_EVENTS, { each: true }) events?: WebhookEvent[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class TestWebhookDto {
  @IsOptional() @IsIn(WEBHOOK_EVENTS) event?: WebhookEvent;
}

class DeliveriesQueryDto {
  @IsOptional() @IsIn(['PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED']) status?: string;
  @IsOptional() @IsISO8601() before?: string;
}

/** Developer API settings page (menu `api`, Admin only by default): API keys and webhooks. */
@Controller('developer')
export class DeveloperController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly webhooks: WebhooksAdminService,
  ) {}

  @Get('api-keys') @RequirePermission('api', 'view')
  listKeys(@Auth() ctx: AuthContext) {
    return this.keys.list(ctx);
  }

  @Post('api-keys') @RequirePermission('api', 'create')
  createKey(@Auth() ctx: AuthContext, @Body() body: CreateApiKeyDto) {
    return this.keys.create(ctx, body);
  }

  @Delete('api-keys/:id') @RequirePermission('api', 'delete')
  revokeKey(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.keys.revoke(ctx, id);
  }

  @Get('webhooks') @RequirePermission('api', 'view')
  listWebhooks(@Auth() ctx: AuthContext) {
    return this.webhooks.list(ctx);
  }

  @Post('webhooks') @RequirePermission('api', 'create')
  createWebhook(@Auth() ctx: AuthContext, @Body() body: WebhookEndpointDtoIn) {
    return this.webhooks.create(ctx, body);
  }

  @Patch('webhooks/:id') @RequirePermission('api', 'edit')
  updateWebhook(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateWebhookDto) {
    return this.webhooks.update(ctx, id, body);
  }

  @Delete('webhooks/:id') @HttpCode(204) @RequirePermission('api', 'delete')
  async deleteWebhook(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.webhooks.remove(ctx, id);
  }

  @Get('webhooks/:id/secret') @RequirePermission('api', 'edit')
  secret(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.secret(ctx, id);
  }

  @Post('webhooks/:id/rotate-secret') @HttpCode(200) @RequirePermission('api', 'edit')
  rotate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.rotateSecret(ctx, id);
  }

  @Post('webhooks/:id/test') @HttpCode(202) @RequirePermission('api', 'edit')
  test(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TestWebhookDto) {
    return this.webhooks.test(ctx, id, body.event);
  }

  @Get('webhooks/:id/deliveries') @RequirePermission('api', 'view')
  deliveries(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: DeliveriesQueryDto) {
    return this.webhooks.deliveries(ctx, id, q);
  }

  @Get('webhook-deliveries/:id') @RequirePermission('api', 'view')
  async delivery(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.webhooks.delivery(ctx, id);
    return { ...toDeliveryDto(d), payload: d.payload };
  }

  @Post('webhook-deliveries/:id/redeliver') @HttpCode(202) @RequirePermission('api', 'edit')
  redeliver(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.redeliver(ctx, id);
  }
}
