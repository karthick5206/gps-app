import { Global, Module } from '@nestjs/common';
import { HistoryArchiveController } from './history-archive.controller';
import { HistoryArchiveService } from './history-archive.service';

/** Global: history, reports, purge and System Health read the archive state. */
@Global()
@Module({ controllers: [HistoryArchiveController], providers: [HistoryArchiveService], exports: [HistoryArchiveService] })
export class HistoryArchiveModule {}
