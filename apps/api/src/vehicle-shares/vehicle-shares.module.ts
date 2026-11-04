import { Module } from '@nestjs/common';
import { VehicleSharesController } from './vehicle-shares.controller';
import { VehicleSharesService } from './vehicle-shares.service';

@Module({ controllers: [VehicleSharesController], providers: [VehicleSharesService] })
export class VehicleSharesModule {}
