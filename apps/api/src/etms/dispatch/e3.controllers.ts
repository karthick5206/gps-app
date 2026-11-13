import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type {
  AuditLogDto,
  BulkApproveTransportBookingsResult,
  ChangeSetResult,
  CreateTransportSchedulesResult,
  DispatchBoardDto,
  DispatchCandidatesDto,
  GeocodeCandidate,
  MeBookingDto,
  MeTripDto,
  MeVehicleDto,
  RepeatTransportTripResult,
  TransportBookingDto,
  TransportChangeSetDetailDto,
  TransportChangeSetSummaryDto,
  TransportBookingPolicyDto,
  TransportGroupBookingResult,
  TransportPlaceOptionDto,
  TransportScheduleDto,
  TransportScheduleExceptionDto,
  TransportSchedulePreviewDto,
  TransportShiftDto,
  TransportTripDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { GeocodeQuery } from '../people/people.dto';
import { PeopleService } from '../people/people.service';
import { PassengerData, TransportFeatureGuard } from '../transport-feature.guard';
import { BookingsService, type Replayable } from './bookings.service';
import { DispatchService } from './dispatch.service';
import {
  BoardQuery,
  BookingCommandDto,
  BookingListQuery,
  BookingPlacesQuery,
  BulkApproveDto,
  CandidatesDto,
  ChangeSetDto,
  ChangeSetListQuery,
  CreateBookingDto,
  CreateExceptionDto,
  CreateGroupBookingDto,
  CreateSchedulesDto,
  CreateShiftDto,
  MeRangeQuery,
  PassengerOutcomeDto,
  RepeatTripDto,
  ScheduleListQuery,
  SchedulePreviewQuery,
  ShiftListQuery,
  TripArriveDto,
  TripCancelDto,
  TripCommandDto,
  TripListQuery,
  UpdateBookingDto,
  UpdateScheduleDto,
  UpdateShiftDto,
} from './e3.dto';
import { MeTransportService } from './me-transport.service';
import { SchedulesService } from './schedules.service';
import { TripsService } from './trips.service';

type HeaderSink = { setHeader?: (name: string, value: string) => unknown } | undefined;

/** Idempotent replay (05 §1): same response, header `Idempotent-Replay: true`. */
function replay<T>(res: HeaderSink, r: Replayable<T>): T {
  if (r.replay) res?.setHeader?.('Idempotent-Replay', 'true');
  return r.value;
}

/** /api/transport/shifts (05 §2.4). Menu etms_schedules; the caller's own company. */
@Controller('transport/shifts')
@UseGuards(TransportFeatureGuard)
export class ShiftsController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get() @RequirePermission('etms_schedules', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ShiftListQuery) {
    return this.schedules.listShifts(ctx, q);
  }

  @Post() @RequirePermission('etms_schedules', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateShiftDto): Promise<TransportShiftDto> {
    return this.schedules.createShift(ctx, dto);
  }

  @Patch(':id') @RequirePermission('etms_schedules', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShiftDto): Promise<TransportShiftDto> {
    return this.schedules.updateShift(ctx, id, dto);
  }

  /** Archive (never a hard delete). */
  @Delete(':id') @RequirePermission('etms_schedules', 'delete')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportShiftDto> {
    return this.schedules.archiveShift(ctx, id);
  }
}

/** /api/transport/schedules (05 §2.4): recurring commutes, exceptions, generator preview. Branch-scoped for ASSIGNED roles. */
@Controller('transport/schedules')
@UseGuards(TransportFeatureGuard)
@PassengerData() // VeeTrax support: X-Access-Reason (passenger personal data)
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get() @RequirePermission('etms_schedules', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ScheduleListQuery) {
    return this.schedules.listSchedules(ctx, q);
  }

  @Get('preview') @RequirePermission('etms_schedules', 'view')
  preview(@Auth() ctx: AuthContext, @Query() q: SchedulePreviewQuery): Promise<TransportSchedulePreviewDto> {
    return this.schedules.preview(ctx, q);
  }

  /** Bulk create: one schedule per passenger × direction; bookings for the next 72 h are generated at once. */
  @Post() @RequirePermission('etms_schedules', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateSchedulesDto): Promise<CreateTransportSchedulesResult> {
    return this.schedules.createSchedules(ctx, dto);
  }

  @Patch(':id') @RequirePermission('etms_schedules', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateScheduleDto): Promise<TransportScheduleDto> {
    return this.schedules.updateSchedule(ctx, id, dto);
  }

  @Delete(':id') @RequirePermission('etms_schedules', 'delete')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportScheduleDto> {
    return this.schedules.archiveSchedule(ctx, id);
  }

  @Get(':id/exceptions') @RequirePermission('etms_schedules', 'view')
  exceptions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportScheduleExceptionDto[]> {
    return this.schedules.listExceptions(ctx, id);
  }

  @Post(':id/exceptions') @RequirePermission('etms_schedules', 'edit')
  addException(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateExceptionDto): Promise<TransportScheduleExceptionDto> {
    return this.schedules.createException(ctx, id, dto);
  }

  @Delete(':id/exceptions/:date') @RequirePermission('etms_schedules', 'edit')
  deleteException(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('date') date: string): Promise<{ deleted: true }> {
    return this.schedules.deleteException(ctx, id, date);
  }
}

/** /api/transport/bookings (05 §2.5). Create needs the Idempotency-Key header. */
@Controller('transport/bookings')
@UseGuards(TransportFeatureGuard)
@PassengerData() // VeeTrax support: X-Access-Reason (passenger personal data)
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly people: PeopleService,
  ) {}

  @Get() @RequirePermission('etms_bookings', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: BookingListQuery) {
    return this.bookings.list(ctx, q);
  }

  @Post('bulk-approve') @HttpCode(200) @RequirePermission('etms_bookings', 'edit')
  bulkApprove(@Auth() ctx: AuthContext, @Body() dto: BulkApproveDto): Promise<BulkApproveTransportBookingsResult> {
    return this.bookings.bulkApprove(ctx, dto.ids);
  }

  /**
   * WP 3.9 wave 2 (D-A8): one booking per passenger (shared groupId / purpose), all or nothing (422 GROUP_INVALID with
   * failures); Idempotency-Key required, a replay answers the same group. Any passenger out of scope: 404.
   */
  @Post('group') @RequirePermission('etms_bookings', 'create')
  async createGroup(@Auth() ctx: AuthContext, @Body() dto: CreateGroupBookingDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<TransportGroupBookingResult> {
    return replay(res, await this.bookings.createGroup(ctx, dto, key));
  }

  /** WP 3.9: the company cut-off and booking limits for the desk's booking form. */
  @Get('policy') @RequireAnyPermission(['etms_bookings', 'create'], ['etms_bookings', 'edit'])
  policy(@Auth() ctx: AuthContext): Promise<TransportBookingPolicyDto> {
    return this.bookings.policy(ctx);
  }

  /** WP 3.9 (D-A2): company places for the booking form (active Pois of the caller's company, at most 50). */
  @Get('places') @RequireAnyPermission(['etms_bookings', 'create'], ['etms_bookings', 'edit'])
  places(@Auth() ctx: AuthContext, @Query() q: BookingPlacesQuery): Promise<TransportPlaceOptionDto[]> {
    return this.bookings.places(ctx, q.q);
  }

  /** WP 3.9: address search for a one-time point, self-hosted Photon only (GEOCODER_NOT_PRIVATE otherwise), as for passengers. */
  @Get('geocode') @RequireAnyPermission(['etms_bookings', 'create'], ['etms_bookings', 'edit'])
  geocode(@Query() q: GeocodeQuery): Promise<GeocodeCandidate[]> {
    return this.people.geocode(q.q);
  }

  @Get(':id') @RequirePermission('etms_bookings', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportBookingDto> {
    return this.bookings.get(ctx, id);
  }

  @Get(':id/events') @RequirePermission('etms_bookings', 'view')
  events(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<AuditLogDto[]> {
    return this.bookings.events(ctx, id);
  }

  @Post() @RequirePermission('etms_bookings', 'create')
  async create(@Auth() ctx: AuthContext, @Body() dto: CreateBookingDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<TransportBookingDto> {
    return replay(res, await this.bookings.create(ctx, dto, key));
  }

  @Patch(':id') @RequirePermission('etms_bookings', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBookingDto): Promise<TransportBookingDto> {
    return this.bookings.update(ctx, id, dto);
  }

  @Post(':id/approve') @HttpCode(200) @RequirePermission('etms_bookings', 'edit')
  approve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookingCommandDto): Promise<TransportBookingDto> {
    return this.bookings.command(ctx, id, 'approve', dto);
  }

  @Post(':id/reject') @HttpCode(200) @RequirePermission('etms_bookings', 'edit')
  reject(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookingCommandDto): Promise<TransportBookingDto> {
    return this.bookings.command(ctx, id, 'reject', dto);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission('etms_bookings', 'edit')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookingCommandDto): Promise<TransportBookingDto> {
    return this.bookings.command(ctx, id, 'cancel', dto);
  }
}

/** /api/transport/dispatch (05 §2.6): board, candidates, change sets (Idempotency-Key) and drafts. */
@Controller('transport/dispatch')
@UseGuards(TransportFeatureGuard)
@PassengerData() // VeeTrax support: X-Access-Reason (passenger personal data)
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get('board') @RequirePermission('etms_dispatch', 'view')
  board(@Auth() ctx: AuthContext, @Query() q: BoardQuery): Promise<DispatchBoardDto> {
    return this.dispatch.board(ctx, q);
  }

  @Post('candidates') @HttpCode(200) @RequirePermission('etms_dispatch', 'view')
  candidates(@Auth() ctx: AuthContext, @Body() dto: CandidatesDto): Promise<DispatchCandidatesDto> {
    return this.dispatch.candidates(ctx, dto);
  }

  @Get('change-sets') @RequirePermission('etms_dispatch', 'view')
  changeSets(@Auth() ctx: AuthContext, @Query() q: ChangeSetListQuery): Promise<TransportChangeSetSummaryDto[]> {
    return this.dispatch.listChangeSets(ctx, q);
  }

  /** A saved change set with its changes (draft details; dispatcher-scoped). */
  @Get('change-sets/:id') @RequirePermission('etms_dispatch', 'view')
  changeSet(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportChangeSetDetailDto> {
    return this.dispatch.changeSet(ctx, id);
  }

  /** Publish (or save as DRAFT with `draft: true`) a change set atomically. */
  @Post('change-sets') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  async submit(@Auth() ctx: AuthContext, @Body() dto: ChangeSetDto, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<ChangeSetResult> {
    return replay(res, await this.dispatch.submit(ctx, dto, key));
  }

  @Post('change-sets/:id/publish') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  async publish(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res?: HeaderSink): Promise<ChangeSetResult> {
    return replay(res, await this.dispatch.publishDraft(ctx, id, key));
  }

  /** Discard a draft. */
  @Delete('change-sets/:id') @RequirePermission('etms_dispatch', 'edit')
  discard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportChangeSetSummaryDto> {
    return this.dispatch.rejectDraft(ctx, id);
  }
}

/** /api/transport/trips (05 §2.6): trip list / detail with manifest, dispatcher progression and passenger outcomes. */
@Controller('transport/trips')
@UseGuards(TransportFeatureGuard)
@PassengerData() // VeeTrax support: X-Access-Reason (passenger personal data)
export class TransportTripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly dispatch: DispatchService,
  ) {}

  @Get() @RequirePermission('etms_dispatch', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: TripListQuery) {
    return this.trips.list(ctx, q);
  }

  @Get(':id') @RequirePermission('etms_dispatch', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<TransportTripDto> {
    return this.trips.get(ctx, id);
  }

  @Post(':id/start') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  start(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TripCommandDto): Promise<TransportTripDto> {
    return this.trips.start(ctx, id, dto);
  }

  @Post(':id/arrive') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  arrive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TripArriveDto): Promise<TransportTripDto> {
    return this.trips.arrive(ctx, id, dto);
  }

  @Post(':id/complete') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  complete(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TripCommandDto): Promise<TransportTripDto> {
    return this.trips.complete(ctx, id, dto);
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TripCancelDto): Promise<TransportTripDto> {
    return this.trips.cancel(ctx, id, dto);
  }

  @Post(':id/acknowledge') @HttpCode(200) @RequirePermission('etms_dispatch', 'command')
  acknowledge(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TripCommandDto): Promise<TransportTripDto> {
    return this.trips.acknowledge(ctx, id, dto);
  }

  @Post(':id/passengers/:passengerTripId/outcome') @HttpCode(200) @RequirePermission('etms_dispatch', 'edit')
  outcome(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('passengerTripId', ParseUUIDPipe) passengerTripId: string, @Body() dto: PassengerOutcomeDto): Promise<TransportTripDto> {
    return this.trips.outcome(ctx, id, passengerTripId, dto);
  }

  /** Copy the assignment to later dates as DRAFT change sets (repeat to date, P2). */
  @Post(':id/repeat') @HttpCode(200) @RequirePermission('etms_dispatch', 'edit')
  repeat(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RepeatTripDto): Promise<RepeatTransportTripResult> {
    return this.dispatch.repeat(ctx, id, dto);
  }
}

/**
 * /api/me/transport/trips and /bookings (05 §2.8): the signed-in passenger's own legs only (etms_self + own active
 * profile, else 403 NOT_A_PASSENGER; other ids 404). The vehicle position only inside the trip window, by polling.
 */
@Controller('me/transport')
@UseGuards(TransportFeatureGuard)
export class MyTransportTripsController {
  constructor(private readonly me: MeTransportService) {}

  @Get('trips') @RequirePermission('etms_self', 'view')
  trips(@Auth() ctx: AuthContext, @Query() q: MeRangeQuery): Promise<MeTripDto[]> {
    return this.me.trips(ctx, q);
  }

  @Get('trips/:id') @RequirePermission('etms_self', 'view')
  trip(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MeTripDto> {
    return this.me.trip(ctx, id);
  }

  @Get('trips/:id/vehicle') @RequirePermission('etms_self', 'view')
  vehicle(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MeVehicleDto> {
    return this.me.vehicle(ctx, id);
  }

  @Get('bookings') @RequirePermission('etms_self', 'view')
  bookings(@Auth() ctx: AuthContext, @Query() q: MeRangeQuery): Promise<MeBookingDto[]> {
    return this.me.bookings(ctx, q);
  }

  @Get('bookings/:id') @RequirePermission('etms_self', 'view')
  booking(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MeBookingDto> {
    return this.me.booking(ctx, id);
  }
}
