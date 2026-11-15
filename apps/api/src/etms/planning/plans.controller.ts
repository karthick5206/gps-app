import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { RoutePlanCompareDto, RoutePlanDetailDto, RoutePlanEditResult, RoutePlanPublishResult, RoutePlanReviewDto, RoutePlanSummaryDto, RoutePlanVersionDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { PassengerData, TransportFeatureGuard } from '../transport-feature.guard';
import { PlanningFeatureGuard } from './planning-feature.guard';
import { AddBookingDto, AssignmentUpdateDto, BookingPinDto, DiscardDto, MovePassengerDto, PlanCompareQuery, PlanListQuery, PublishDto, RecalculateDto, RemoveBookingQuery, ResequenceDto, RestoreDto, ReviewQuery, StopUpdateDto } from './plans.dto';
import { RoutePlansService } from './plans.service';

type HeaderSink = { setHeader?: (name: string, value: string) => unknown } | undefined;

/**
 * /api/transport/route-plans (doc 17 §7 P9): ETMS route plans under the company / branch scope (404 out of scope).
 * Menu etms_planning: view = list / detail / history / compare / review; edit = manual edits (incl. WP-B restore,
 * recalculate, add / remove / pin a booking); delete = discard; command = publish (also needs etms_dispatch:command). Hidden (404) unless ETMS and ETMS_ROUTING=on and the company add-on etms.
 */
@Controller('transport/route-plans')
@UseGuards(TransportFeatureGuard, PlanningFeatureGuard)
@PassengerData() // VeeTrax support: X-Access-Reason (passenger personal data)
export class RoutePlansController {
  constructor(private readonly plans: RoutePlansService) {}

  @Get() @RequirePermission('etms_planning', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: PlanListQuery): Promise<RoutePlanSummaryDto[]> {
    return this.plans.list(ctx, q);
  }

  /** Metrics only (no stops, points or names). */
  @Get('compare') @RequirePermission('etms_planning', 'view')
  compare(@Auth() ctx: AuthContext, @Query() q: PlanCompareQuery): Promise<RoutePlanCompareDto> {
    return this.plans.compare(ctx, q.ids);
  }

  @Get(':id') @RequirePermission('etms_planning', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutePlanDetailDto> {
    return this.plans.get(ctx, id);
  }

  @Get(':id/history') @RequirePermission('etms_planning', 'view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RoutePlanVersionDto[]> {
    return this.plans.history(ctx, id);
  }

  @Post(':id/move-passenger') @HttpCode(200) @RequirePermission('etms_planning', 'edit')
  movePassenger(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MovePassengerDto): Promise<RoutePlanEditResult> {
    return this.plans.movePassenger(ctx, id, dto);
  }

  @Put(':id/sequence') @RequirePermission('etms_planning', 'edit')
  resequence(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResequenceDto): Promise<RoutePlanEditResult> {
    return this.plans.resequence(ctx, id, dto);
  }

  @Patch(':id/assignments/:assignmentId') @RequirePermission('etms_planning', 'edit')
  updateAssignment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('assignmentId', ParseUUIDPipe) assignmentId: string, @Body() dto: AssignmentUpdateDto): Promise<RoutePlanEditResult> {
    return this.plans.updateAssignment(ctx, id, assignmentId, dto);
  }

  @Patch(':id/stops/:stopId') @RequirePermission('etms_planning', 'edit')
  updateStop(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('stopId', ParseUUIDPipe) stopId: string, @Body() dto: StopUpdateDto): Promise<RoutePlanEditResult> {
    return this.plans.updateStop(ctx, id, stopId, dto);
  }

  /** WP-B undo / redo: restore the route membership and order of an earlier version. */
  @Post(':id/restore') @HttpCode(200) @RequirePermission('etms_planning', 'edit')
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RestoreDto): Promise<RoutePlanEditResult> {
    return this.plans.restore(ctx, id, dto);
  }

  /** WP-B: re-time routes on the road engine (default: every unpublished route with stops). */
  @Post(':id/recalculate') @HttpCode(200) @RequirePermission('etms_planning', 'edit')
  recalculate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecalculateDto): Promise<RoutePlanEditResult> {
    return this.plans.recalculate(ctx, id, dto);
  }

  /** WP-B: add an open booking of the plan's scope (its stops unassigned). */
  @Post(':id/bookings') @HttpCode(200) @RequirePermission('etms_planning', 'edit')
  addBooking(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBookingDto): Promise<RoutePlanEditResult> {
    return this.plans.addBooking(ctx, id, dto);
  }

  /** WP-B: take a booking's stops off the plan (the booking stays open). */
  @Delete(':id/bookings/:bookingId') @RequirePermission('etms_planning', 'edit')
  removeBooking(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Query() q: RemoveBookingQuery): Promise<RoutePlanEditResult> {
    return this.plans.removeBooking(ctx, id, bookingId, q.expectedVersion);
  }

  /** WP-B: pin / unpin both stops of a passenger's booking. */
  @Patch(':id/bookings/:bookingId/pin') @RequirePermission('etms_planning', 'edit')
  pinBooking(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Body() dto: BookingPinDto): Promise<RoutePlanEditResult> {
    return this.plans.pinBooking(ctx, id, bookingId, dto);
  }

  /** WP-B: the confirmation document of a publish selection, with the reviewHash publish requires. */
  @Get(':id/review') @RequirePermission('etms_planning', 'view')
  review(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ReviewQuery): Promise<RoutePlanReviewDto> {
    return this.plans.review(ctx, id, q);
  }

  @Post(':id/discard') @HttpCode(200) @RequirePermission('etms_planning', 'delete')
  discard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DiscardDto): Promise<RoutePlanDetailDto> {
    return this.plans.discard(ctx, id, dto);
  }

  /** Into ordinary E3 trips through the E3 publish transaction; replay with the same Idempotency-Key. */
  @Post(':id/publish') @HttpCode(200) @RequirePermission('etms_planning', 'command')
  async publish(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<RoutePlanPublishResult> {
    const r = await this.plans.publish(ctx, id, dto, key);
    if (r.replay) res?.setHeader?.('Idempotent-Replay', 'true');
    return r.value;
  }
}
