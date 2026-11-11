import { Module } from '@nestjs/common';
import { AgreementViewsService } from './agreements/agreement-views.service';
import { AgreementsController } from './agreements/agreements.controller';
import { AgreementsService } from './agreements/agreements.service';
import { CompanyDirectoryController } from './directory/company-directory.controller';
import { CompanyDirectoryService } from './directory/company-directory.service';
import { TransportSettingsController } from './settings/transport-settings.controller';
import { TransportSettingsService } from './settings/transport-settings.service';

/**
 * Employee transport (ETMS). E1a: service agreements, the partner directory and the company ETMS settings; later phases
 * add their controllers here.
 */
@Module({
  controllers: [AgreementsController, CompanyDirectoryController, TransportSettingsController],
  providers: [AgreementsService, AgreementViewsService, CompanyDirectoryService, TransportSettingsService],
  exports: [AgreementsService],
})
export class EtmsModule {}
