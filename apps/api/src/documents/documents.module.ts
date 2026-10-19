import { Module } from '@nestjs/common';
import { MastersModule } from '../masters/masters.module';
import { DocumentsController, ServiceRemindersController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { RemindersService } from './reminders.service';
import { ServiceRemindersService } from './service-reminders.service';

@Module({
  imports: [MastersModule],
  controllers: [DocumentsController, ServiceRemindersController],
  providers: [DocumentsService, ServiceRemindersService, RemindersService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
