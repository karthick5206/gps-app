import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IDEMPOTENT_REPLAY_HEADER, type IncidentDetail, type IncidentListResponse, type SosReceipt } from '@veetracer/shared';
import type { Response } from 'express';
import { requireSupportReason } from '../../access/access-reason';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { IgnoresTransportCustomer, TransportFeatureGuard } from '../transport-feature.guard';
import { IncidentsService } from './incidents.service';
import { SosService, type SosResult } from './sos.service';

/** Status 201 (new incident) / 200 (replay or merge) and the replay header, then the receipt. */
function answer(res: Response | undefined, r: SosResult): SosReceipt {
  if (res) {
    res.status(r.created ? 201 : 200);
    if (r.replay) res.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
  }
  return r.receipt;
}

/**
 * POST / GET /api/me/transport/sos (doc 05 §2.8 / §3.7; WP 5.4): the passenger's durable SOS. etms_self + the caller's
 * own passenger profile (403 NOT_A_PASSENGER). The body is untyped on purpose (no ValidationPipe whitelist): an SOS is
 * never refused because of an unknown or malformed field (sos-rules cleanSos drops bad pieces).
 */
@Controller('me/transport/sos')
@UseGuards(TransportFeatureGuard)
export class MySosController {
  constructor(private readonly sos: SosService) {}

  @Post() @RequirePermission('etms_self', 'view')
  async raise(@Auth() ctx: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key?: string, @Res({ passthrough: true }) res?: Response): Promise<SosReceipt> {
    return answer(res, await this.sos.raisePassenger(ctx, body, key));
  }

  @Get(':id') @RequirePermission('etms_self', 'view')
  receipt(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SosReceipt> {
    return this.sos.receiptPassenger(ctx, id);
  }
}

/**
 * POST / GET /api/driver/v1/sos (doc 05 §2.9; WP 5.4): the driver's fast-path SOS, ahead of (never inside) the event
 * queue. etms_driver:view (an SOS must not depend on the edit grant) + the caller's own Driver row (403 NOT_A_DRIVER).
 */
@Controller('driver/v1/sos')
@UseGuards(TransportFeatureGuard)
export class DriverSosController {
  constructor(private readonly sos: SosService) {}

  @Post() @RequirePermission('etms_driver', 'view')
  async raise(@Auth() ctx: AuthContext, @Body() body: unknown, @Headers('idempotency-key') key?: string, @Res({ passthrough: true }) res?: Response): Promise<SosReceipt> {
    return answer(res, await this.sos.raiseDriver(ctx, body, key));
  }

  @Get(':id') @RequirePermission('etms_driver', 'view')
  receipt(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SosReceipt> {
    return this.sos.receiptDriver(ctx, id);
  }
}

/**
 * /api/transport/incidents (doc 05 §2.10; WP 5.4): the dispatcher's SOS lane. etms_incidents:view (list, detail) and
 * :edit (acknowledge with a note, resolve with an outcome + note; never VeeTrax support, M1). Rows outside the caller's incident scope are 404;
 * agreement rows without MANAGE_INCIDENTS are 403 FORBIDDEN_GRANT on writes.
 */
@Controller('transport/incidents')
@UseGuards(TransportFeatureGuard)
@IgnoresTransportCustomer() // QA B1: an SOS is never hidden by the customer picker
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get() @RequirePermission('etms_incidents', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: Record<string, string>): Promise<IncidentListResponse> {
    return this.incidents.list(ctx, { open: q.open, limit: q.limit });
  }

  /** Security review M1: VeeTrax support (Super Admin) reads the detail only with X-Access-Reason (400 REASON_REQUIRED). */
  @Get(':id') @RequirePermission('etms_incidents', 'view')
  detail(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('x-access-reason') reason?: string): Promise<IncidentDetail> {
    return this.incidents.detail(ctx, id, { reason: requireSupportReason(ctx, reason) });
  }

  @Post(':id/ack') @HttpCode(200) @RequirePermission('etms_incidents', 'edit')
  ack(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<IncidentDetail> {
    return this.incidents.ack(ctx, id, body);
  }

  @Post(':id/resolve') @HttpCode(200) @RequirePermission('etms_incidents', 'edit')
  resolve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<IncidentDetail> {
    return this.incidents.resolve(ctx, id, body);
  }
}
