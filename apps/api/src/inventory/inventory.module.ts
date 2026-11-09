import { Module } from '@nestjs/common';
import { MastersModule } from '../masters/masters.module';
import { InventoryCatalogService } from './catalog.service';
import { InventoryController } from './inventory.controller';
import { InventoryStockService } from './stock.service';

/**
 * Device inventory (Phase B): stock locations, suppliers, receipts, device stock status and the movement ledger.
 * Depends on MastersModule only for the Device Inventory create path (new IMEIs); never on licence seats.
 */
@Module({
  imports: [MastersModule],
  controllers: [InventoryController],
  providers: [InventoryCatalogService, InventoryStockService],
})
export class InventoryModule {}
