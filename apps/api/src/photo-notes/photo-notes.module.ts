import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ExpensesModule } from '../expenses/expenses.module';
import { MobileTrackerModule } from '../mobile-tracker/mobile-tracker.module';
import { PhotoNotesController, TrackerPhotoNotesController } from './photo-notes.controller';
import { PhotoNotesService } from './photo-notes.service';

@Module({
  imports: [ExpensesModule, MobileTrackerModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  controllers: [PhotoNotesController, TrackerPhotoNotesController],
  providers: [PhotoNotesService],
  exports: [PhotoNotesService],
})
export class PhotoNotesModule {}
