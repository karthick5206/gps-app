import { Module } from '@nestjs/common';
import { LicencesModule } from '../licences/licences.module';
import { MastersModule } from '../masters/masters.module';
import { StockDashboardService } from './stock-dashboard.service';
import { StockInvoicesService } from './stock-invoices.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

/** Stock (inventory): purchase → receipt → sale → returns, invoices, inventory dashboard. */
@Module({
  imports: [MastersModule, LicencesModule],
  controllers: [StockController],
  providers: [StockService, StockInvoicesService, StockDashboardService],
})
export class StockModule {}
