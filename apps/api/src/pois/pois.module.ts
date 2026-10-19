import { Module } from '@nestjs/common';
import { GeofencesModule } from '../masters/geofences/geofences.module';
import { PoisController } from './pois.controller';
import { PoisService } from './pois.service';

@Module({ imports: [GeofencesModule], controllers: [PoisController], providers: [PoisService] })
export class PoisModule {}
