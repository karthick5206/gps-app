import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { CommandsController, DeviceInfoController } from './commands.controller';
import { CommandsService } from './commands.service';
import { DvrAutoSetupService } from './dvr-auto-setup.service';

@Module({
  imports: [LiveModule],
  controllers: [CommandsController, DeviceInfoController],
  providers: [CommandsService, DvrAutoSetupService],
  exports: [CommandsService],
})
export class CommandsModule {}
