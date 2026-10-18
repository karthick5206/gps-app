import { Body, Controller, HttpCode, Post, StreamableFile } from '@nestjs/common';
import { ReportResponse } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { ReportDataService } from './report-data.service';
import { FILE_MAX_ROWS, renderReport } from './report-files';
import { normalizeScope, ReportExportDto, ReportRequestDto } from './reports.dto';

@Controller('reports')
export class ReportsController {
  constructor(private readonly data: ReportDataService) {}

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

  /** File download (XLSX / PDF / CSV). */
  @Post('export') @HttpCode(200) @RequirePermission('reports', 'export')
  async export(@Auth() ctx: AuthContext, @Body() dto: ReportExportDto): Promise<StreamableFile> {
    const { format, ...req } = dto;
    const data = await this.data.generate(ctx, { ...req, scope: normalizeScope(req.scope) }, FILE_MAX_ROWS[format]);
    const file = await renderReport([data], format);
    return new StreamableFile(file.buffer, {
      type: file.contentType,
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.buffer.length,
    });
  }
}
