import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { CommandsController, DeviceInfoController } from './commands.controller';
import { CommandsService } from './commands.service';

@Module({
  imports: [LiveModule],
  controllers: [CommandsController, DeviceInfoController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
