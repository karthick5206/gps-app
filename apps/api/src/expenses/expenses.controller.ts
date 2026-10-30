import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EXPENSE_KINDS, type ExpenseDto, type ExpenseKind, type ExpenseSummaryDto } from '@veetracer/shared';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { ExpensesService, type UploadedBill } from './expenses.service';

class ExpenseBody {
  @IsUUID() objectId!: string;
  @IsIn(EXPENSE_KINDS) kind!: ExpenseKind;
  @IsISO8601() at!: string;
  @IsInt() @Min(1) @Max(100_000_000) amountPaise!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(2000) litres?: number | null;
  @IsOptional() @IsString() @MaxLength(120) vendor?: string | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

class ListQuery {
  @IsOptional() @IsUUID() objectId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(EXPENSE_KINDS) kind?: ExpenseKind;
}

class SummaryQuery {
  @IsISO8601() from!: string;
  @IsISO8601() to!: string;
}

/** Fuel & expense log with bill photos; km per litre and cost per km. */
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get() @RequirePermission('expenses', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ListQuery): Promise<ExpenseDto[]> {
    return this.expenses.list(ctx, q);
  }

  @Get('summary') @RequirePermission('expenses', 'view')
  summary(@Auth() ctx: AuthContext, @Query() q: SummaryQuery): Promise<ExpenseSummaryDto> {
    return this.expenses.summary(ctx, q.from, q.to);
  }

  @Post() @RequirePermission('expenses', 'create')
  create(@Auth() ctx: AuthContext, @Body() body: ExpenseBody): Promise<ExpenseDto> {
    return this.expenses.create(ctx, body);
  }

  @Post(':id/photo') @RequirePermission('expenses', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  attach(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: UploadedBill): Promise<ExpenseDto> {
    return this.expenses.attach(ctx, id, file);
  }

  @Get(':id/photo') @RequirePermission('expenses', 'view')
  photo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    return this.expenses.photo(ctx, id);
  }

  @Delete(':id') @RequirePermission('expenses', 'delete')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.expenses.remove(ctx, id);
  }
}
