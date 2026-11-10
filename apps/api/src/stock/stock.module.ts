import { Module } from '@nestjs/common';
import { LicencesModule } from '../licences/licences.module';
import { MastersModule } from '../masters/masters.module';
import { InventoryLinkService } from './inventory-link.service';
import { StockDashboardService } from './stock-dashboard.service';
import { StockInvoicesService } from './stock-invoices.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

/** Purchases & sales: purchase → receipt → sale → returns, invoices, dashboard; trackers kept in Stock & movements. */
@Module({
  imports: [MastersModule, LicencesModule],
  controllers: [StockController],
  providers: [StockService, StockInvoicesService, StockDashboardService, InventoryLinkService],
})
export class StockModule {}
