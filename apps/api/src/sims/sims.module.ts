import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AssetLinksService } from './asset-links.service';
import { AssetLinksController, SimsController } from './sims.controller';
import { SimsService } from './sims.service';

/**
 * SIM management (Phase C) and the tenant read-only asset view. Depends on InventoryModule only for stock-location
 * checks; never on licence seats, Device writes or invoices.
 */
@Module({
  imports: [InventoryModule],
  controllers: [SimsController, AssetLinksController],
  providers: [SimsService, AssetLinksService],
})
export class SimsModule {}
