import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { StopDto, TripDto } from '@veetracer/shared';
import { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { hasPermission } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../access/decorators';
import { AuditService } from '../audit/audit.service';
import { CsvColumn, csvFile } from '../common/csv';
import { GeocodingService } from '../geocoding/geocoding.service';
import { fixed, hhmmss, localTime } from '../reports/format';
import { HistoryService } from './history.service';

const gzipAsync = promisify(gzip);

export class HistoryQuery {
  @IsOptional() @IsString() @MaxLength(40) from?: string;
  @IsOptional() @IsString() @MaxLength(40) to?: string;
  @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

export class ReverseGeocodeQuery {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng!: number;
}

function tripColumns(tz: string): CsvColumn<TripDto>[] {
  return [
    { header: 'Vehicle', value: (t) => t.objectName },
    { header: 'Start', value: (t) => localTime(t.startTime, tz) },
    { header: 'End', value: (t) => localTime(t.endTime, tz) },
    { header: 'Duration', value: (t) => hhmmss(t.durationSec) },
    { header: 'Idle', value: (t) => hhmmss(t.idleSec) },
    { header: 'Distance (km)', value: (t) => fixed(t.distanceKm, 2) },
    { header: 'Max speed (km/h)', value: (t) => fixed(t.maxSpeedKph) },
    { header: 'Avg speed (km/h)', value: (t) => fixed(t.avgSpeedKph) },
    { header: 'Start address', value: (t) => t.startAddress ?? `${t.startLat.toFixed(5)}, ${t.startLng.toFixed(5)}` },
    { header: 'End address', value: (t) => t.endAddress ?? `${t.endLat.toFixed(5)}, ${t.endLng.toFixed(5)}` },
  ];
}

function stopColumns(tz: string): CsvColumn<StopDto>[] {
  return [
    { header: 'Vehicle', value: (s) => s.objectName },
    { header: 'Start', value: (s) => localTime(s.startTime, tz) },
    { header: 'End', value: (s) => localTime(s.endTime, tz) },
    { header: 'Duration', value: (s) => hhmmss(s.durationSec) },
    { header: 'Type', value: (s) => (s.ignitionOn ? 'Idle (engine on)' : 'Parked') },
    { header: 'Address', value: (s) => s.address ?? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` },
  ];
}

@Controller()
export class HistoryController {
  constructor(
    private readonly history: HistoryService,
    private readonly audit: AuditService,
    private readonly geocoding: GeocodingService,
  ) {}

  /**
   * Track history (`?from&to`, menu `history`). This path is shared with the M1 objects master's audit history
   * (`GET /objects/:id/history` without from/to → AuditLogDto[], menu `objects`), which is served here unchanged.
   */
  @Get('objects/:id/history') @RequireAnyPermission(['history', 'view'], ['objects', 'view'])
  async objectHistory(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: HistoryQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (q.from === undefined && q.to === undefined) {
      if (!hasPermission(ctx, 'objects', 'view')) throw new ForbiddenException('Permission denied');
      await this.history.objectMeta(ctx, id);
      return this.audit.history(ctx, 'object', id);
    }
    if (!hasPermission(ctx, 'history', 'view')) throw new ForbiddenException('Permission denied');
    const body = await this.history.history(ctx, id, q.from, q.to);
    // Large payload: gzip it in one go (the streaming compression middleware is ~10× slower here and skips
    // responses that are already encoded).
    const json = Buffer.from(JSON.stringify(body), 'utf8');
    res.setHeader('Vary', 'Accept-Encoding');
    if (json.length < 2048 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      return new StreamableFile(json, { type: 'application/json; charset=utf-8', length: json.length });
    }
    const packed = await gzipAsync(json, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    return new StreamableFile(packed, { type: 'application/json; charset=utf-8', length: packed.length });
  }

  @Get('objects/:id/trips') @RequirePermission('history', 'view')
  async trips(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: HistoryQuery) {
    const trips = await this.history.trips(ctx, id, q.from, q.to);
    if (q.format !== 'csv') return trips;
    const meta = await this.history.objectMeta(ctx, id);
    return csvFile('trips', trips, tripColumns(meta.tz));
  }

  @Get('objects/:id/stops') @RequirePermission('history', 'view')
  async stops(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: HistoryQuery) {
    const stops = await this.history.stops(ctx, id, q.from, q.to);
    if (q.format !== 'csv') return stops;
    const meta = await this.history.objectMeta(ctx, id);
    return csvFile('stops', stops, stopColumns(meta.tz));
  }

  /** Any logged-in user: address for the playback panel. */
  @Get('geocode/reverse')
  async reverse(@Query() q: ReverseGeocodeQuery): Promise<{ address: string | null }> {
    return { address: await this.geocoding.reverse(q.lat, q.lng) };
  }
}
