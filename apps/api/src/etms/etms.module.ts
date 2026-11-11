import { Module } from '@nestjs/common';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';

/** Employee transport (ETMS). E1a: service agreements; later phases add their controllers here. */
@Module({ controllers: [AgreementsController], providers: [AgreementsService], exports: [AgreementsService] })
export class EtmsModule {}
