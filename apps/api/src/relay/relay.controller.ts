import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { RELAY_AUTH_TYPES, RELAY_MAX_SCOPE_DEVICES, RELAY_PROTOCOLS, RELAY_SCOPES, RELAY_TARGET_TYPES, RelayAuthType, RelayScope, RelayTargetType } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { RELAY_LIMITS } from './guard';
import { RelayAdminService } from './relay-admin.service';

class UpdateRelayTargetDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(RELAY_TARGET_TYPES) type?: RelayTargetType;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(253) host?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number | null;
  @IsOptional() @IsBoolean() passDownstream?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @IsIn(RELAY_AUTH_TYPES) authType?: RelayAuthType;
  @IsOptional() @IsString() @MaxLength(2000) authValue?: string | null;
  @IsOptional() @IsBoolean() includeAlerts?: boolean;
  @IsOptional() @IsIn(RELAY_SCOPES) scope?: RelayScope;
  @IsOptional() @IsUUID() companyId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(RELAY_MAX_SCOPE_DEVICES) @IsUUID('all', { each: true }) deviceIds?: string[];
  @IsOptional() @IsIn(RELAY_PROTOCOLS) protocol?: string | null;
  @IsOptional() @IsBoolean() liveOnly?: boolean;
  @IsOptional() @IsBoolean() validOnly?: boolean;
}

class CreateRelayTargetDto {
  @IsString() @Length(1, 80) name!: string;
  @IsIn(RELAY_TARGET_TYPES) type!: RelayTargetType;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(253) host?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number | null;
  @IsOptional() @IsBoolean() passDownstream?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @IsIn(RELAY_AUTH_TYPES) authType?: RelayAuthType;
  @IsOptional() @IsString() @MaxLength(2000) authValue?: string | null;
  @IsOptional() @IsBoolean() includeAlerts?: boolean;
  @IsIn(RELAY_SCOPES) scope!: RelayScope;
  @IsOptional() @IsUUID() companyId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(RELAY_MAX_SCOPE_DEVICES) @IsUUID('all', { each: true }) deviceIds?: string[];
  @IsOptional() @IsIn(RELAY_PROTOCOLS) protocol?: string | null;
  @IsOptional() @IsBoolean() liveOnly?: boolean;
  @IsOptional() @IsBoolean() validOnly?: boolean;
}

/** Platform → Data forwarding (Super Admin only, menu `sa_relay`). */
@Controller('admin/relay-targets')
export class RelayController {
  constructor(private readonly relay: RelayAdminService) {}

  @Get() @RequirePermission('sa_relay', 'view')
  async list() {
    return { items: await this.relay.list(), maxTargets: RELAY_LIMITS.maxTargets(), ownHosts: this.relay.policy.ownHosts, devicePorts: this.relay.policy.devicePorts };
  }

  @Post() @RequirePermission('sa_relay', 'create')
  create(@Auth() ctx: AuthContext, @Body() body: CreateRelayTargetDto) {
    return this.relay.create(ctx, body);
  }

  @Patch(':id') @RequirePermission('sa_relay', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRelayTargetDto) {
    return this.relay.update(ctx, id, body);
  }

  @Delete(':id') @HttpCode(204) @RequirePermission('sa_relay', 'delete')
  async remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.relay.remove(ctx, id);
  }

  @Post(':id/test') @HttpCode(200) @RequirePermission('sa_relay', 'edit')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.relay.test(id);
  }

  @Get(':id/secret') @RequirePermission('sa_relay', 'edit')
  secret(@Param('id', ParseUUIDPipe) id: string) {
    return this.relay.secret(id);
  }

  @Post(':id/rotate-secret') @HttpCode(200) @RequirePermission('sa_relay', 'edit')
  rotate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.relay.rotateSecret(ctx, id);
  }
}

@Module({
  controllers: [RelayController],
  providers: [RelayAdminService],
})
export class RelayModule {}
