import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { DeveloperModule } from '../developer/developer.module';
import { LiveModule } from '../live/live.module';
import { ReportsModule } from '../reports/reports.module';
import { OpenApiController } from './openapi.controller';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';

/** Public REST API v1 (/api/v1/…) for customers' own systems, authenticated with API keys. */
@Module({
  imports: [DeveloperModule, ReportsModule, CommandsModule, LiveModule],
  // OpenApiController first: GET /v1/openapi.json must not hit a keyed route.
  controllers: [OpenApiController, PublicApiController],
  providers: [PublicApiService],
})
export class PublicApiModule {}
