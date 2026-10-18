import { Global, Module } from '@nestjs/common';
import { SystemMessagesService } from './system-messages.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/** Message templates API and SYSTEM_* rendering (exported globally for auth and scheduled reports). */
@Global()
@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, SystemMessagesService],
  exports: [SystemMessagesService],
})
export class TemplatesModule {}
