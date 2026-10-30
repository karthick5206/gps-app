import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { SearchAnswerDto } from '@veetracer/shared';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { SmartSearchService } from './smart-search.service';

class AskBody {
  @IsString() @MinLength(1) @MaxLength(200) q!: string;
}

/** Ask VeeTrax: typed or spoken questions about the caller's own vehicles (no AI). */
@Controller('ask')
export class SmartSearchController {
  constructor(private readonly search: SmartSearchService) {}

  @Post() @HttpCode(200) @RequirePermission('live_map', 'view')
  ask(@Auth() ctx: AuthContext, @Body() body: AskBody): Promise<SearchAnswerDto> {
    return this.search.ask(ctx, body.q);
  }
}
