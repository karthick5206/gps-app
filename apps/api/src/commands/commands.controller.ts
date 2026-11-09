import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AvailableCommand, COMMAND_TYPES, CommandDto, CommandType, EngineStopPrepareRequest, EngineStopPrepareResponse, SendCommandRequest } from '@veetracer/shared';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { CommandsService } from './commands.service';

class SendCommandDto implements SendCommandRequest {
  @IsIn(COMMAND_TYPES) type!: CommandType;
  @IsOptional() @IsString() @Length(1, 200) text?: string;
  @IsOptional() @IsString() @MaxLength(128) password?: string;
  @IsOptional() @IsUUID() prepareRequestId?: string;
}

class PrepareEngineStopDto implements EngineStopPrepareRequest {
  @IsOptional() @IsUUID() requestId?: string;
}

/** Commands are sent from the live map; `live_map:command` is the permission that allows it. */
@Controller('objects/:id/commands')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Get('available') @RequirePermission('live_map', 'command')
  available(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<AvailableCommand[]> {
    return this.commands.available(ctx, id);
  }

  @Get() @RequirePermission('live_map', 'command')
  list(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<CommandDto[]> {
    return this.commands.list(ctx, id);
  }

  @Post() @RequirePermission('live_map', 'command')
  send(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SendCommandDto): Promise<CommandDto> {
    return this.commands.send(ctx, id, body);
  }

  /**
   * Engine stop, step 1: ask a connected tracker for a fresh position (no body) or poll that request (`requestId`).
   * Never sends or queues the engine stop; step 2 is POST /objects/:id/commands with `prepareRequestId`.
   */
  @Post('engine-stop/prepare') @HttpCode(200) @RequirePermission('live_map', 'command')
  prepareEngineStop(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PrepareEngineStopDto): Promise<EngineStopPrepareResponse> {
    return this.commands.prepareEngineStop(ctx, id, body);
  }
}

/** Super Admin (Device Inventory): ask a tracker for its SIM ICCID and firmware version. */
@Controller('admin/devices/:id/read-info')
export class DeviceInfoController {
  constructor(private readonly commands: CommandsService) {}

  @Post() @HttpCode(200) @RequirePermission('sa_device_inventory', 'edit')
  read(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.commands.readDeviceInfo(ctx, id);
  }
}
