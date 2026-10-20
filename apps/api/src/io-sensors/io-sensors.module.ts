import { Module } from '@nestjs/common';
import { IoSensorsController } from './io-sensors.controller';
import { IoSensorsService } from './io-sensors.service';

@Module({ controllers: [IoSensorsController], providers: [IoSensorsService] })
export class IoSensorsModule {}
