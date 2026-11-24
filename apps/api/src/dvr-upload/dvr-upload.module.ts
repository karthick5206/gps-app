import { Module } from '@nestjs/common';
import { DvrUploadController } from './dvr-upload.controller';
import { DvrUploadService } from './dvr-upload.service';

/** HTTP photo / clip uploads from dashcams that use HTTP instead of a TCP attachment server (Jimi JC400 / JC261). */
@Module({
  controllers: [DvrUploadController],
  providers: [DvrUploadService],
})
export class DvrUploadModule {}
