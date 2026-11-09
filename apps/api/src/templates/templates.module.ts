import { Global, Module } from '@nestjs/common';
import { ArattaiSettingsController } from './arattai-settings.controller';
import { SystemMessagesService } from './system-messages.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/** Message templates API and SYSTEM_* rendering (exported globally for auth and scheduled reports). */
@Global()
@Module({
  controllers: [TemplatesController, ArattaiSettingsController],
  providers: [TemplatesService, SystemMessagesService],
  exports: [SystemMessagesService],
})
export class TemplatesModule {}
