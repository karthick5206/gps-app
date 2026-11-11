import { Module } from '@nestjs/common';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';
import { EtmsPeopleModule } from './people/people.module';

/** Employee transport (ETMS). E1a: service agreements; E2: people (EtmsPeopleModule); later phases add theirs here. */
@Module({ imports: [EtmsPeopleModule], controllers: [AgreementsController], providers: [AgreementsService], exports: [AgreementsService] })
export class EtmsModule {}
