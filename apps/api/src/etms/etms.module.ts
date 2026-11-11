import { Module } from '@nestjs/common';
import { AgreementViewsService } from './agreements/agreement-views.service';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';
import { CompanyDirectoryController } from './directory/company-directory.controller';
import { CompanyDirectoryService } from './directory/company-directory.service';

/** Employee transport (ETMS). E1a: service agreements and the partner directory; later phases add their controllers here. */
@Module({
  controllers: [AgreementsController, CompanyDirectoryController],
  providers: [AgreementsService, AgreementViewsService, CompanyDirectoryService],
  exports: [AgreementsService],
})
export class EtmsModule {}
