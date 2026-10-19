import { Module } from '@nestjs/common';
import { WebhooksAdminService } from '../webhooks/webhooks-admin.service';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeysService } from './api-keys.service';
import { DeveloperController } from './developer.controller';

/** API keys and webhook endpoints (admin), plus the key guard used by the public API. */
@Module({
  controllers: [DeveloperController],
  providers: [ApiKeysService, ApiKeyGuard, WebhooksAdminService],
  exports: [ApiKeysService, ApiKeyGuard, WebhooksAdminService],
})
export class DeveloperModule {}
