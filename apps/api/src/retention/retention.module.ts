import { Module } from '@nestjs/common';
import { PhotoNotesModule } from '../photo-notes/photo-notes.module';
import { RetentionService } from './retention.service';

@Module({ imports: [PhotoNotesModule], providers: [RetentionService] })
export class RetentionModule {}
