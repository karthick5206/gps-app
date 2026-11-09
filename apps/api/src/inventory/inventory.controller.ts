import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile } from '@nestjs/common';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { InventoryCatalogService } from './catalog.service';
import { InventoryDashboardService } from './dashboard.service';
import { InventoryReplaceService } from './replace.service';
import {
  AdjustDto,
  ChangeStatusDto,
  CreateLocationDto,
  CreateReceiptDto,
  CreateSupplierDto,
  DashboardQuery,
  ImportDto,
  ReplaceDto,
  LocationListQuery,
  MovementListQuery,
  ReceiptListQuery,
  StockListQuery,
  SupplierListQuery,
  SyncDto,
  TransferDto,
  UpdateLocationDto,
  UpdateSupplierDto,
} from './inventory.dto';
import { IMPORT_TEMPLATE_HEADER } from './stock-csv';
import { InventoryStockService } from './stock.service';

/**
 * Platform → Stock & Movements (Super Admin only: menu `sa_inventory` is superAdminOnly, never granted to a role).
 * Customer assignment is not here: it stays on Device Inventory (admin assign / move), Transfer and Claim.
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly catalog: InventoryCatalogService,
    private readonly stock: InventoryStockService,
    private readonly dashboards: InventoryDashboardService,
    private readonly replacements: InventoryReplaceService,
  ) {}

  // Locations
  @Get('locations') @RequirePermission('sa_inventory', 'view')
  listLocations(@Query() query: LocationListQuery) {
    return this.catalog.listLocations(query);
  }

  @Get('locations/:id') @RequirePermission('sa_inventory', 'view')
  getLocation(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getLocation(id);
  }

  @Post('locations') @RequirePermission('sa_inventory', 'create')
  createLocation(@Auth() ctx: AuthContext, @Body() dto: CreateLocationDto) {
    return this.catalog.createLocation(ctx, dto);
  }

  @Patch('locations/:id') @RequirePermission('sa_inventory', 'edit')
  updateLocation(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.catalog.updateLocation(ctx, id, dto);
  }

  @Delete('locations/:id') @RequirePermission('sa_inventory', 'delete')
  async removeLocation(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.removeLocation(ctx, id);
    return { ok: true };
  }

  // Suppliers
  @Get('suppliers') @RequirePermission('sa_inventory', 'view')
  listSuppliers(@Query() query: SupplierListQuery) {
    return this.catalog.listSuppliers(query);
  }

  @Get('suppliers/:id') @RequirePermission('sa_inventory', 'view')
  getSupplier(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getSupplier(id);
  }

  @Post('suppliers') @RequirePermission('sa_inventory', 'create')
  createSupplier(@Auth() ctx: AuthContext, @Body() dto: CreateSupplierDto) {
    return this.catalog.createSupplier(ctx, dto);
  }

  @Patch('suppliers/:id') @RequirePermission('sa_inventory', 'edit')
  updateSupplier(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.catalog.updateSupplier(ctx, id, dto);
  }

  @Delete('suppliers/:id') @RequirePermission('sa_inventory', 'delete')
  async removeSupplier(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.removeSupplier(ctx, id);
    return { ok: true };
  }

  // Receipts (purchase / goods receipt)
  @Get('receipts') @RequirePermission('sa_inventory', 'view')
  listReceipts(@Query() query: ReceiptListQuery) {
    return this.stock.listReceipts(query);
  }

  @Get('receipts/:id') @RequirePermission('sa_inventory', 'view')
  getReceipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.stock.getReceipt(id);
  }

  @Post('receipts') @RequirePermission('sa_inventory', 'create')
  createReceipt(@Auth() ctx: AuthContext, @Body() dto: CreateReceiptDto) {
    return this.stock.createReceipt(ctx, dto);
  }

  // CSV bulk import (dry-run by default)
  @Get('import/template') @RequirePermission('sa_inventory', 'view')
  importTemplate() {
    return new StreamableFile(Buffer.from(`${IMPORT_TEMPLATE_HEADER}\r\n`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="inventory-import-template.csv"',
    });
  }

  @Post('import') @HttpCode(200) @RequirePermission('sa_inventory', 'create')
  importCsv(@Auth() ctx: AuthContext, @Body() dto: ImportDto) {
    return this.stock.importCsv(ctx, dto);
  }

  // Stock (list supports ?format=csv, which also needs `export`)
  @Get('stock') @RequirePermission('sa_inventory', 'view')
  listStock(@Query() query: StockListQuery) {
    return this.stock.list(query);
  }

  @Get('stock/summary') @RequirePermission('sa_inventory', 'view')
  summary() {
    return this.stock.summary();
  }

  @Get('stock/:deviceId') @RequirePermission('sa_inventory', 'view')
  getStock(@Param('deviceId', ParseUUIDPipe) deviceId: string) {
    return this.stock.get(deviceId);
  }

  @Get('stock/:deviceId/movements') @RequirePermission('sa_inventory', 'view')
  deviceMovements(@Param('deviceId', ParseUUIDPipe) deviceId: string, @Query() query: MovementListQuery) {
    return this.stock.movements({ ...query, deviceId });
  }

  @Post('stock/:deviceId/status') @HttpCode(200) @RequirePermission('sa_inventory', 'edit')
  changeStatus(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) deviceId: string, @Body() dto: ChangeStatusDto) {
    return this.stock.changeStatus(ctx, deviceId, dto);
  }

  @Post('stock/:deviceId/transfer') @HttpCode(200) @RequirePermission('sa_inventory', 'edit')
  transfer(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) deviceId: string, @Body() dto: TransferDto) {
    return this.stock.transfer(ctx, deviceId, dto);
  }

  @Post('stock/:deviceId/adjust') @HttpCode(200) @RequirePermission('sa_inventory', 'edit')
  adjust(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) deviceId: string, @Body() dto: AdjustDto) {
    return this.stock.adjust(ctx, deviceId, dto);
  }

  @Post('stock/:deviceId/sync') @HttpCode(200) @RequirePermission('sa_inventory', 'edit')
  sync(@Auth() ctx: AuthContext, @Param('deviceId', ParseUUIDPipe) deviceId: string, @Body() dto: SyncDto) {
    return this.stock.sync(ctx, deviceId, dto);
  }

  // Dashboard (read-only)
  @Get('dashboard') @RequirePermission('sa_inventory', 'view')
  dashboard(@Query() query: DashboardQuery) {
    return this.dashboards.dashboard(query.days ?? 30);
  }

  // Replacement of a fitted unit (vehicle fitting through the existing objects flow; no licence seat change)
  @Get('replace/candidates') @RequirePermission('sa_inventory', 'view')
  replaceCandidates(@Query('objectId', ParseUUIDPipe) objectId: string) {
    return this.replacements.candidates(objectId);
  }

  @Post('replace') @HttpCode(200) @RequirePermission('sa_inventory', 'edit')
  replace(@Auth() ctx: AuthContext, @Body() dto: ReplaceDto) {
    return this.replacements.replace(ctx, dto);
  }

  // Movement ledger (read-only; ?format=csv export)
  @Get('movements') @RequirePermission('sa_inventory', 'view')
  movements(@Query() query: MovementListQuery) {
    return this.stock.movements(query);
  }
}
