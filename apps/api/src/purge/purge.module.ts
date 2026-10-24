import { Module } from '@nestjs/common';
import { AccountDeletionController, PurgeController } from './purge.controller';
import { PurgeService } from './purge.service';

@Module({ controllers: [PurgeController, AccountDeletionController], providers: [PurgeService] })
export class PurgeModule {}
