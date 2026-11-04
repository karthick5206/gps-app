import { Body, Controller, Get, Put, Query, StreamableFile } from '@nestjs/common';
import { ATTENDANCE_OVERRIDES, type AttendanceDayDto, type AttendanceFix, type AttendanceOverride, type AttendanceRowDto, type AttendanceSettingsDto, type OutingKind } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuthContext } from '../access/auth-context';
import { Auth, RequirePermission } from '../access/decorators';
import { csvFile } from '../common/csv';
import { AttendanceService } from './attendance.service';

class ShiftBody {
  @IsString() @MaxLength(100) id!: string;
  @IsString() @MaxLength(100) name!: string;
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsInt() @Min(0) @Max(1439) endMin!: number;
  @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) branchIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) objectIds!: string[];
}

class SettingsBody {
  @IsBoolean() enabled!: boolean;
  @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) geofenceIds!: string[];
  @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) objectIds!: string[];
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) days!: number[];
  @IsInt() @Min(0) @Max(1439) startMin!: number;
  @IsInt() @Min(0) @Max(1439) endMin!: number;
  @IsInt() @Min(0) @Max(180) graceMin!: number;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ShiftBody) shifts!: ShiftBody[];
  @IsInt() @Min(0) @Max(60) shortExitMin!: number;
  @IsInt() @Min(15) @Max(240) noSignalMin!: number;
  @IsInt() @Min(0) @Max(1440) halfDayMin!: number;
  @IsInt() @Min(0) @Max(1440) fullDayMin!: number;
  @IsInt() @Min(0) @Max(720) outReminderMin!: number;
  @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) anyBranchObjectIds!: string[];
  @IsBoolean() selfieRequired!: boolean;
}

class SelfieQuery {
  @IsUUID() objectId!: string;
  @IsString() day!: string;
}

class DayQuery {
  @IsOptional() @IsString() day?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

class SheetQuery {
  @IsString() from!: string;
  @IsString() to!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

class OutingBody {
  @IsUUID() objectId!: string;
  @IsISO8601() leftAt!: string;
  @IsIn(['UNEXPLAINED', 'OFFICIAL', 'PERSONAL']) kind!: OutingKind;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class CorrectionBody {
  @IsUUID() objectId!: string;
  @IsString() day!: string;
  @IsOptional() @IsIn(ATTENDANCE_OVERRIDES) status!: AttendanceOverride | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '');
const hours = (min: number) => (min / 60).toFixed(2);
const place = (f: AttendanceFix | null) => (f ? `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}` : '');
const metres = (f: AttendanceFix | null) => (f?.accuracyM === null || f?.accuracyM === undefined ? '' : Math.round(f.accuracyM));
const statusOf = (r: AttendanceRowDto) => (r.halfDay ? 'HALF_DAY' : r.status);

/** Staff attendance: settings, today's board, decisions on time outside, timesheet (JSON / CSV). */
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

  @Put('outing') @RequirePermission('attendance', 'edit')
  outing(@Auth() ctx: AuthContext, @Body() body: OutingBody): Promise<AttendanceRowDto> {
    return this.attendance.decideOuting(ctx, body);
  }

  @Put('correction') @RequirePermission('attendance', 'edit')
  correction(@Auth() ctx: AuthContext, @Body() body: CorrectionBody): Promise<AttendanceRowDto> {
    return this.attendance.correctDay(ctx, { ...body, status: body.status ?? null });
  }

  @Get() @RequirePermission('attendance', 'view')
  day(@Auth() ctx: AuthContext, @Query() q: DayQuery): Promise<AttendanceDayDto> {
    return this.attendance.day(ctx, q.day, q.branchId);
  }

  @Get('selfie') @RequirePermission('attendance', 'view')
  selfie(@Auth() ctx: AuthContext, @Query() q: SelfieQuery): Promise<StreamableFile> {
    return this.attendance.selfie(ctx, q.objectId, q.day);
  }

  @Get('timesheet') @RequirePermission('attendance', 'view')
  async timesheet(@Auth() ctx: AuthContext, @Query() q: SheetQuery): Promise<AttendanceRowDto[] | StreamableFile> {
    const rows = await this.attendance.timesheet(ctx, q.from, q.to, q.branchId);
    if (q.format !== 'csv') return rows;
    return csvFile('timesheet', rows, [
      { header: 'Date', value: (r) => r.day },
      { header: 'Staff', value: (r) => r.name },
      { header: 'Branch', value: (r) => r.branch ?? '' },
      { header: 'Shift', value: (r) => r.shift },
      { header: 'Status', value: statusOf },
      { header: 'First in', value: (r) => time(r.firstIn) },
      { header: 'Last out', value: (r) => time(r.lastOut) },
      { header: 'Hours worked', value: (r) => hours(r.workedMin) },
      { header: 'Hours on site', value: (r) => hours(r.onSiteMin) },
      { header: 'Hours official duty', value: (r) => hours(r.officialMin) },
      { header: 'Hours personal', value: (r) => hours(r.personalMin) },
      { header: 'Hours unexplained', value: (r) => hours(r.unexplainedMin) },
      { header: 'Hours no signal', value: (r) => hours(r.noSignalMin) },
      { header: 'Late (min)', value: (r) => r.lateMin || '' },
      { header: 'Early leave (min)', value: (r) => r.earlyMin || '' },
      { header: 'Overtime (min)', value: (r) => r.overtimeMin || '' },
      { header: 'Site', value: (r) => r.site ?? '' },
      { header: 'First in location', value: (r) => place(r.inFix) },
      { header: 'First in accuracy (m)', value: (r) => metres(r.inFix) },
      { header: 'Last out location', value: (r) => place(r.outFix) },
      { header: 'Last out accuracy (m)', value: (r) => metres(r.outFix) },
      { header: 'Selfie', value: (r) => (r.selfieAt ? time(r.selfieAt) : r.selfieMissing ? 'Missing' : '') },
      { header: 'Corrected', value: (r) => (r.corrected ? `Yes${r.correctionNote ? `: ${r.correctionNote}` : ''}` : '') },
    ]);
  }
}
