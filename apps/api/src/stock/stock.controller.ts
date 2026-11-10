import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, StreamableFile, UploadedFile, UseInterceptors, HttpCode } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  STOCK_DOC_KINDS,
  STOCK_ITEM_KINDS,
  STOCK_ORDER_CHANNELS,
  STOCK_SALE_TO,
  type StockDashboardDto,
  type StockDocDto,
  type StockDocKind,
  type StockItemDto,
  type StockItemKind,
  type StockStoreDto,
  type StockOnHandRow,
  type StockOrderChannel,
  type StockPriceDto,
  type StockSaleTo,
  type StockSerialDto,
  type StockSupplierDto,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { StockDashboardService } from './stock-dashboard.service';
import { StockInvoicesService } from './stock-invoices.service';
import { StockService, type UploadedStockFile } from './stock.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class ItemBody {
  @IsString() @MaxLength(120) name!: string;
  @IsIn(STOCK_ITEM_KINDS) kind!: StockItemKind;
  @IsOptional() @IsUUID() deviceModelId!: string | null;
  @IsOptional() @IsString() @MaxLength(60) sku!: string | null;
  @IsString() @MaxLength(12) hsnCode!: string;
  @IsNumber() @Min(0) @Max(40) gstRatePct!: number;
  @IsString() @MaxLength(12) unit!: string;
  @IsBoolean() serialTracked!: boolean;
  @IsInt() @Min(0) @Max(100_000_000) salePricePaise!: number;
  @IsInt() @Min(0) @Max(100_000_000) purchasePricePaise!: number;
  @IsOptional() @IsInt() @Min(0) lowStockAt!: number | null;
  @IsOptional() @IsInt() @Min(0) reorderQty!: number | null;
  @IsBoolean() isActive!: boolean;
}

class ReorderBody {
  @IsIn(STOCK_ITEM_KINDS) kind!: StockItemKind;
  @IsOptional() @IsInt() @Min(0) lowStockAt!: number | null;
  @IsOptional() @IsInt() @Min(0) reorderQty?: number | null;
}

class PriceBody {
  @IsUUID() itemId!: string;
  @IsOptional() @IsUUID() partnerId?: string | null;
  @IsOptional() @IsUUID() companyId?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) pricePaise!: number | null;
}

class SupplierBody {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(15) gstin!: string | null;
  @IsString() @MaxLength(2) stateCode!: string;
  @IsString() @MaxLength(300) address!: string;
  @IsString() @MaxLength(60) city!: string;
  @IsString() @MaxLength(6) pin!: string;
  @IsString() @MaxLength(80) contactName!: string;
  @IsString() @MaxLength(20) phone!: string;
  @IsString() @MaxLength(120) email!: string;
  @IsString() @MaxLength(500) notes!: string;
  @IsInt() @Min(0) @Max(365) leadTimeDays!: number;
  @IsBoolean() isActive!: boolean;
}

class LineBody {
  @IsUUID() itemId!: string;
  @IsInt() @Min(-100_000) @Max(100_000) qty!: number;
  @IsInt() @Min(0) @Max(100_000_000) ratePaise!: number;
  @IsNumber() @Min(0) @Max(40) gstRatePct!: number;
  @IsArray() @ArrayMaxSize(5000) @IsString({ each: true }) @MaxLength(40, { each: true }) serials!: string[];
  @IsIn(['OK', 'DAMAGED']) condition!: 'OK' | 'DAMAGED';
  @IsString() @MaxLength(300) note!: string;
}

class DocBody {
  @IsIn(STOCK_DOC_KINDS) kind!: StockDocKind;
  @IsIn(['DRAFT', 'DONE', 'OPEN', 'CANCELLED']) status!: 'DRAFT' | 'DONE' | 'OPEN' | 'CANCELLED';
  @Matches(DAY) docDate!: string;
  @IsOptional() @IsUUID() supplierId?: string | null;
  @IsOptional() @IsBoolean() toPlatform?: boolean;
  @IsOptional() @IsIn(STOCK_SALE_TO) saleTo?: StockSaleTo | null;
  @IsOptional() @IsUUID() customerCompanyId?: string | null;
  @IsOptional() @IsUUID() customerPartnerId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) customerName?: string;
  @IsOptional() @IsString() @MaxLength(20) customerPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) customerEmail?: string;
  @IsOptional() @IsString() @MaxLength(15) customerGstin?: string | null;
  @IsOptional() @IsString() @MaxLength(2) customerStateCode?: string;
  @IsOptional() @IsString() @MaxLength(300) customerAddress?: string;
  @IsOptional() @IsUUID() locationId?: string | null;
  @IsOptional() @IsUUID() sourceId?: string | null;
  @IsOptional() @IsIn(STOCK_ORDER_CHANNELS) channel?: StockOrderChannel | null;
  @IsOptional() @IsString() @MaxLength(60) supplierInvoiceNo?: string;
  @IsOptional() @Matches(DAY) supplierInvoiceDate?: string | null;
  @IsOptional() @IsInt() @Min(0) supplierInvoiceAmountPaise?: number | null;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => LineBody) lines!: LineBody[];
}

class DocQuery {
  @IsOptional() @IsIn(STOCK_DOC_KINDS) kind?: StockDocKind;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() @MaxLength(60) search?: string;
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @IsIn(['1', 'true']) inbox?: string;
}

class SerialsQuery {
  @IsUUID() itemId!: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsIn(['IN_STOCK', 'DAMAGED', 'SOLD']) status!: 'IN_STOCK' | 'DAMAGED' | 'SOLD';
}

class PriceForQuery {
  @IsUUID() itemId!: string;
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsUUID() companyId?: string;
}

class PaymentBody {
  @IsInt() @Min(0) paidPaise!: number;
  @IsOptional() @IsString() @MaxLength(20) paymentMode?: string;
  @IsOptional() @IsString() @MaxLength(120) paymentReference?: string;
}

/**
 * Stock: items, suppliers, stores, documents (PO → receipt → return; order → sale → return; adjustment), files,
 * stock on hand, IMEI history, sales invoices and credit notes. Platform (Super Admin) and resellers only.
 */
@Controller('stock')
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly invoices: StockInvoicesService,
    private readonly board: StockDashboardService,
  ) {}

  @Get('items') @RequirePermission('stock', 'view')
  items(@Auth() ctx: AuthContext): Promise<StockItemDto[]> {
    return this.stock.items(ctx);
  }

  @Post('items') @RequirePermission('stock', 'create')
  createItem(@Auth() ctx: AuthContext, @Body() b: ItemBody): Promise<StockItemDto> {
    return this.stock.saveItem(ctx, null, b);
  }

  @Put('items/reorder-level') @RequirePermission('stock', 'edit')
  reorder(@Auth() ctx: AuthContext, @Body() b: ReorderBody): Promise<StockItemDto[]> {
    return this.stock.setReorderLevel(ctx, { kind: b.kind, lowStockAt: b.lowStockAt ?? null, reorderQty: b.reorderQty });
  }

  @Get('dashboard') @RequirePermission('stock', 'view')
  dashboard(@Auth() ctx: AuthContext): Promise<StockDashboardDto> {
    return this.board.dashboard(ctx);
  }

  @Put('items/:id') @RequirePermission('stock', 'edit')
  updateItem(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: ItemBody): Promise<StockItemDto> {
    return this.stock.saveItem(ctx, id, b);
  }

  @Get('items/:id/prices') @RequirePermission('stock', 'view')
  prices(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StockPriceDto[]> {
    return this.stock.prices(ctx, id);
  }

  @Put('prices') @RequirePermission('stock', 'edit')
  setPrice(@Auth() ctx: AuthContext, @Body() b: PriceBody): Promise<StockPriceDto[]> {
    return this.stock.setPrice(ctx, { ...b, pricePaise: b.pricePaise ?? null });
  }

  @Get('price') @RequirePermission('stock', 'view')
  priceFor(@Auth() ctx: AuthContext, @Query() q: PriceForQuery): Promise<{ pricePaise: number }> {
    return this.stock.priceFor(ctx, q.itemId, { partnerId: q.partnerId, companyId: q.companyId });
  }

  @Get('suppliers') @RequirePermission('stock', 'view')
  suppliers(@Auth() ctx: AuthContext): Promise<StockSupplierDto[]> {
    return this.stock.suppliers(ctx);
  }

  @Post('suppliers') @RequirePermission('stock', 'create')
  createSupplier(@Auth() ctx: AuthContext, @Body() b: SupplierBody): Promise<StockSupplierDto> {
    return this.stock.saveSupplier(ctx, null, b);
  }

  @Put('suppliers/:id') @RequirePermission('stock', 'edit')
  updateSupplier(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: SupplierBody): Promise<StockSupplierDto> {
    return this.stock.saveSupplier(ctx, id, b);
  }

  @Get('locations') @RequirePermission('stock', 'view')
  locations(@Auth() ctx: AuthContext): Promise<StockStoreDto[]> {
    return this.stock.locations(ctx);
  }

  @Get('docs') @RequirePermission('stock', 'view')
  docs(@Auth() ctx: AuthContext, @Query() q: DocQuery): Promise<StockDocDto[]> {
    return this.stock.listDocs(ctx, { ...q, inbox: !!q.inbox });
  }

  @Get('docs/:id') @RequirePermission('stock', 'view')
  doc(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StockDocDto> {
    return this.stock.getDoc(ctx, id);
  }

  @Post('docs') @RequirePermission('stock', 'create')
  createDoc(@Auth() ctx: AuthContext, @Body() b: DocBody): Promise<StockDocDto> {
    return this.stock.saveDoc(ctx, null, b);
  }

  @Put('docs/:id') @RequirePermission('stock', 'edit')
  updateDoc(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: DocBody): Promise<StockDocDto> {
    return this.stock.saveDoc(ctx, id, b);
  }

  @Delete('docs/:id') @RequirePermission('stock', 'delete')
  deleteDoc(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.stock.deleteDoc(ctx, id);
  }

  @Post('docs/:id/files') @RequirePermission('stock', 'edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  attach(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: UploadedStockFile): Promise<StockDocDto> {
    return this.stock.attach(ctx, id, file);
  }

  @Get('files/:id') @RequirePermission('stock', 'view')
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return this.stock.file(ctx, id);
  }

  @Delete('files/:id') @RequirePermission('stock', 'edit')
  removeFile(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StockDocDto> {
    return this.stock.removeFile(ctx, id);
  }

  @Get('on-hand') @RequirePermission('stock', 'view')
  onHand(@Auth() ctx: AuthContext): Promise<StockOnHandRow[]> {
    return this.stock.onHand(ctx);
  }

  @Get('available') @RequirePermission('stock', 'view')
  available(@Auth() ctx: AuthContext, @Query() q: SerialsQuery): Promise<string[]> {
    return this.stock.availableSerials(ctx, q.itemId, q.locationId ?? null, q.status);
  }

  /** Super Admin: compare (dryRun=true, nothing written) or bring Stock & movements in step with Purchases & sales. */
  @Post('sync-inventory') @HttpCode(200) @RequirePermission('stock', 'edit')
  syncInventory(@Auth() ctx: AuthContext, @Query('dryRun') dryRun?: string) {
    return this.stock.syncRegister(ctx, dryRun !== 'false');
  }

  @Get('serials/:serial') @RequirePermission('stock', 'view')
  serial(@Auth() ctx: AuthContext, @Param('serial') serial: string): Promise<StockSerialDto[]> {
    return this.stock.serial(ctx, serial);
  }

  @Post('docs/:id/invoice') @RequirePermission('stock', 'create')
  invoice(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StockDocDto> {
    return this.invoices.issue(ctx, id);
  }

  @Put('invoices/:id/payment') @RequirePermission('stock', 'edit')
  payment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() b: PaymentBody): Promise<StockDocDto> {
    return this.invoices.payment(ctx, id, b);
  }

  @Get('invoices/:id/pdf') @RequirePermission('stock', 'view')
  pdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return this.invoices.pdf(ctx, id);
  }
}
