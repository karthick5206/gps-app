import { Module } from '@nestjs/common';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';

@Module({ controllers: [FuelController], providers: [FuelService] })
export class FuelModule {}
