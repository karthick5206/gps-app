import { BadRequestException, Body, Controller, HttpCode, Optional, Post, StreamableFile } from '@nestjs/common';
import { PERIOD_REPORT_TYPES, pickRowsByKey, ReportRequest, ReportResponse, ROW_KEY_LENGTH, splitRowKeys, VIEW_MAX_ROWS } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportData, ReportDataService } from './report-data.service';
import { FILE_MAX_ROWS, FileSection, renderReport } from './report-files';
import { buildSummary, describeOptions, ReportLogo, SummaryFilter } from './report-summary';
import { normalizeScope, ReportExportDto, ReportRequestDto, ReportViewDto } from './reports.dto';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly data: ReportDataService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly settings?: LicenceSettingsService,
  ) {}

  /** JSON result (max 10,000 rows; `totals` always cover every matching row). */
  @Post('run') @HttpCode(200) @RequirePermission('reports', 'view')
  async run(
    @Auth() ctx: AuthContext,
    @Body() dto: ReportRequestDto,
  ): Promise<ReportResponse & { truncated: boolean; totalRows: number }> {
    const r = await this.data.generate(ctx, { ...dto, scope: normalizeScope(dto.scope) });
    return {
      type: r.type,
      from: r.from,
      to: r.to,
      ...(r.period ? { period: r.period } : {}),
      rows: r.rows,
      totals: r.totals,
      truncated: r.truncated,
      totalRows: r.totalRows,
    };
  }

  /**
   * File download (XLSX / PDF / CSV). Without `summary` / `view` the file is exactly as before. `summary` adds the PDF
   * cover page / XLSX Summary sheet; `view` exports only the rows the page shows ("Export filtered view").
   */
  @Post('export') @HttpCode(200) @RequirePermission('reports', 'export')
  async export(@Auth() ctx: AuthContext, @Body() dto: ReportExportDto): Promise<StreamableFile> {
    const { format, summary, view, ...rest } = dto;
    const req: ReportRequest = { ...rest, scope: normalizeScope(rest.scope) };
    if (view && view.rows.length % ROW_KEY_LENGTH) throw new BadRequestException('view.rows must be row keys');
    // A filtered view names rows of the on-screen result (first 10,000 rows), so generate at least that many.
    const max = view ? Math.max(FILE_MAX_ROWS[format], VIEW_MAX_ROWS) : FILE_MAX_ROWS[format];
    const data = await this.data.generate(ctx, req, max);
    const section: FileSection = { ...data };
    if (summary && format !== 'CSV') section.summary = buildSummary(data, await this.filters(ctx, req, data, view), await this.logo());
    if (view) applyView(section, view, FILE_MAX_ROWS[format]);
    const file = await renderReport([section], format);
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.buffer.length,
    });
  }

  /** The operator logo set in platform billing settings (as on invoices), if any. */
  private async logo(): Promise<ReportLogo | null> {
    try {
      return (await this.settings?.logo()) ?? null;
    } catch {
      return null;
    }
  }

  /** Cover lines describing the selection: scope by name, grouping and the report options used. */
  private async filters(ctx: AuthContext, req: ReportRequest, data: ReportData, view?: ReportViewDto): Promise<SummaryFilter[]> {
    const out: SummaryFilter[] = [];
    const scope = req.scope ?? { branchIds: [], groupIds: [], objectIds: [] };
    const names = (list: string[], max = 8) => (list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', '));
    if (scope.branchIds.length && this.prisma) {
      const rows = await this.prisma.branch.findMany({ where: { id: { in: scope.branchIds }, companyId: ctx.companyId }, select: { name: true }, orderBy: { name: 'asc' } });
      out.push({ label: 'Branches', value: rows.length ? names(rows.map((r) => r.name)) : `${scope.branchIds.length} selected` });
    }
    if (scope.groupIds.length && this.prisma) {
      const rows = await this.prisma.vehicleGroup.findMany({ where: { id: { in: scope.groupIds }, companyId: ctx.companyId }, select: { name: true }, orderBy: { name: 'asc' } });
      out.push({ label: 'Vehicle groups', value: rows.length ? names(rows.map((r) => r.name)) : `${scope.groupIds.length} selected` });
    }
    if (scope.objectIds.length) {
      // Names the caller may see: their own vehicles in scope, else the names on the report rows (shared vehicles).
      const own = await this.data.scopeObjects(ctx, { branchIds: [], groupIds: [], objectIds: scope.objectIds });
      const fromRows = new Map((data.rows as { objectId?: string; objectName?: string }[]).filter((r) => r.objectId && r.objectName).map((r) => [r.objectId!, r.objectName!]));
      const list = scope.objectIds.map((id) => own.get(id)?.name ?? fromRows.get(id)).filter((n): n is string => !!n);
      out.push({ label: 'Vehicles', value: list.length === scope.objectIds.length ? names(list) : `${scope.objectIds.length} selected` });
    }
    if (!out.length) out.push({ label: 'Vehicles', value: 'All vehicles you can access' });
    if (PERIOD_REPORT_TYPES.includes(req.type) && req.period) out.push({ label: 'Grouped by', value: req.period.toLowerCase() });
    out.push(...describeOptions(req.type, req.options));
    if (view) out.push({ label: 'Filtered view', value: view.label?.trim() || 'Rows filtered on screen' });
    return out;
  }
}

/** Keeps the rows the page showed (by row key, in its order) and drops the totals, which cover the whole report. */
export function applyView(section: FileSection, view: ReportViewDto, fileMax: number): void {
  const keys = splitRowKeys(view.rows);
  const picked = pickRowsByKey(section.rows as Record<string, unknown>[], keys);
  const rows = picked.rows.slice(0, fileMax);
  const notes = [`Filtered view${view.label?.trim() ? ` (${view.label.trim()})` : ''}: ${rows.length} of ${section.totalRows} rows. Totals are left out because they cover the whole report.`];
  if (picked.missing) notes.push(`${picked.missing} of the selected rows were not found because the data changed after the report ran; run the report again for an exact copy.`);
  if (picked.rows.length > fileMax) notes.push(`This format holds the first ${fileMax} rows of the view.`);
  if (section.summary) section.summary.viewNote = 'Key figures and charts cover the whole report; the table is the filtered view.';
  section.rows = rows;
  section.totals = undefined;
  section.truncated = false;
  section.notes = notes;
  section.omitHeaders = view.hiddenColumns ?? [];
}
