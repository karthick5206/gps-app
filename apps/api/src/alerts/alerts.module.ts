import { Global, Module } from '@nestjs/common';
import { AlertTargetsService } from './alert-targets.service';
import {
  AlertPacksController,
  AlertsController,
  AlertSettingsController,
  AlertSnoozesController,
  AlertTypesController,
  RecipientListsController,
} from './alerts.controllers';
import { AlertSyncService } from './alerts/alert-sync.service';
import { AlertsService } from './alerts/alerts.service';
import { NotifyQueueService } from './notify-queue.service';
import { OfflineAlertService } from './offline-alerts.service';
import { RecipientListsService } from './recipients/recipient-lists.service';
import { AlertSettingsService } from './settings/alert-settings.service';
import { SnoozesPacksService } from './snoozes-packs/snoozes-packs.service';

/** Alerts API, alert settings/recipients/snoozes/packs, and the DEVICE_OFFLINE hook used by the offline sweeper. */
@Global()
@Module({
  controllers: [
    AlertTypesController,
    AlertSettingsController,
    RecipientListsController,
    AlertSnoozesController,
    AlertPacksController,
    AlertsController,
  ],
  providers: [
    AlertTargetsService,
    AlertSettingsService,
    RecipientListsService,
    SnoozesPacksService,
    AlertsService,
    AlertSyncService,
    NotifyQueueService,
    OfflineAlertService,
  ],
  exports: [AlertTargetsService, NotifyQueueService, OfflineAlertService, AlertsService],
})
export class AlertsModule {}
