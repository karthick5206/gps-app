import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { TransferResult } from '@veetracer/shared';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth } from '../access/decorators';
import { TransferService } from './transfer.service';

class TransferParams {
  @IsIn(['object', 'device', 'driver']) kind!: 'object' | 'device' | 'driver';
  @IsUUID() id!: string;
}

class TransferBody {
  @IsUUID() targetCompanyId!: string;
  /** Vehicles only: true = its history moves along, false = start fresh (history stays with the old company). */
  @IsOptional() @IsBoolean() withHistory?: boolean;
}

/** Super Admin: move a vehicle, device or driver to another company. */
@Controller('admin/transfer')
export class TransferController {
  constructor(private readonly transfer: TransferService) {}

  @Post(':kind/:id') @HttpCode(200)
  move(@Auth() ctx: AuthContext, @Param() p: TransferParams, @Body() body: TransferBody): Promise<TransferResult> {
    if (p.kind === 'object') return this.transfer.moveObject(ctx, p.id, body.targetCompanyId, body.withHistory ?? true);
    if (p.kind === 'device') return this.transfer.moveDevice(ctx, p.id, body.targetCompanyId);
    return this.transfer.moveDriver(ctx, p.id, body.targetCompanyId);
  }
}
