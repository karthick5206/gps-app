import { Body, Controller, Get, Put, Query, StreamableFile } from '@nestjs/common';
import type { AttendanceDayDto, AttendanceRowDto, AttendanceSettingsDto } from '@veetracer/shared';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { csvFile } from '../common/csv';
import { AttendanceService } from './attendance.service';

class SettingsBody {
  @IsBoolean() enabled!: boolean;
  @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) geofenceIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) objectIds!: string[];
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsInt() @Min(0) @Max(1439) endMin!: number;
  @IsInt() @Min(0) @Max(180) graceMin!: number;
}

class DayQuery {
  @IsOptional() @IsString() day?: string;
}

class SheetQuery {
  @IsString() from!: string;
  @IsString() to!: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '');

/** Field staff attendance: settings, today's board, timesheet (JSON / CSV). */
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('settings') @RequirePermission('attendance', 'view')
  settings(@Auth() ctx: AuthContext): Promise<AttendanceSettingsDto> {
    return this.attendance.settings(ctx.companyId);
  }

  @Put('settings') @RequirePermission('attendance', 'edit')
  save(@Auth() ctx: AuthContext, @Body() body: SettingsBody): Promise<AttendanceSettingsDto> {
    return this.attendance.saveSettings(ctx, body);
  }

  @Get() @RequirePermission('attendance', 'view')
  day(@Auth() ctx: AuthContext, @Query() q: DayQuery): Promise<AttendanceDayDto> {
    return this.attendance.day(ctx, q.day);
  }

  @Get('timesheet') @RequirePermission('attendance', 'view')
  async timesheet(@Auth() ctx: AuthContext, @Query() q: SheetQuery): Promise<AttendanceRowDto[] | StreamableFile> {
    const rows = await this.attendance.timesheet(ctx, q.from, q.to);
    if (q.format !== 'csv') return rows;
    return csvFile('timesheet', rows, [
      { header: 'Date', value: (r) => r.day },
      { header: 'Staff', value: (r) => r.name },
      { header: 'Status', value: (r) => r.status },
      { header: 'First in', value: (r) => time(r.firstIn) },
      { header: 'Last out', value: (r) => time(r.lastOut) },
      { header: 'Hours on site', value: (r) => (r.onSiteMin / 60).toFixed(2) },
      { header: 'Late (min)', value: (r) => r.lateMin || '' },
      { header: 'Site', value: (r) => r.site ?? '' },
    ]);
  }
}
