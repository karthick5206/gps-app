import { Module } from '@nestjs/common';
import { DeviceClaimController, ShipmentsController } from './device-claim.controller';
import { DeviceClaimService } from './device-claim.service';

@Module({ controllers: [DeviceClaimController, ShipmentsController], providers: [DeviceClaimService] })
export class DeviceClaimModule {}
