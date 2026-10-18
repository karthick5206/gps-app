import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AvailableCommand, COMMAND_TYPES, CommandDto, CommandType, SendCommandRequest } from '@veetracer/shared';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { CommandsService } from './commands.service';

class SendCommandDto implements SendCommandRequest {
  @IsIn(COMMAND_TYPES) type!: CommandType;
  @IsOptional() @IsString() @Length(1, 200) text?: string;
  @IsOptional() @IsString() @MaxLength(128) password?: string;
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
}
