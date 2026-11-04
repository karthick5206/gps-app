import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { SharedVehicleDto, VehicleShareDto } from '@veetracer/shared';
import { IsBoolean, IsISO8601, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission } from '../access/decorators';
import { VehicleSharesService } from './vehicle-shares.service';

class ListQuery {
  @IsUUID() objectId!: string;
}

class CreateBody {
  @IsUUID() objectId!: string;
  @IsUUID() companyId!: string;
  @IsOptional() @IsBoolean() alertsOn?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() endAt?: string | null;
}

class UpdateBody {
  @IsOptional() @IsBoolean() alertsOn?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() endAt?: string | null;
}

@Controller()
export class VehicleSharesController {
  constructor(private readonly shares: VehicleSharesService) {}

  /** Super Admin (checked in the service). */
  @Get('admin/vehicle-shares')
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery): Promise<VehicleShareDto[]> {
    return this.shares.list(ctx, q.objectId);
  }

  @Post('admin/vehicle-shares')
  create(@Auth() ctx: AuthContext, @Body() body: CreateBody): Promise<VehicleShareDto> {
    return this.shares.create(ctx, body);
  }

  @Patch('admin/vehicle-shares/:id')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBody): Promise<VehicleShareDto> {
    return this.shares.update(ctx, id, body);
  }

  @Delete('admin/vehicle-shares/:id')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.shares.remove(ctx, id);
  }

  /** The caller's company: vehicles shared with it. */
  @Get('vehicle-shares/mine') @RequireAnyPermission(['reports', 'view'], ['history', 'view'], ['live_map', 'view'])
  mine(@Auth() ctx: AuthContext): Promise<SharedVehicleDto[]> {
    return this.shares.mine(ctx);
  }
}
