import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PASSENGER_IMPORT_MAX_BYTES,
  type DriverLoginDto as DriverLoginResult,
  type GeocodeCandidate,
  type PassengerAppAccessResult,
  type PassengerConsentsDto,
  type PassengerDto,
  type PassengerImportResult,
  type TransportVehicleProfileDto,
  type TransportVehicleProfileResponse,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequireAnyPermission, RequirePermission } from '../../access/decorators';
import { TransportFeatureGuard } from '../transport-feature.guard';
import { FleetLinksService } from './fleet-links.service';
import { PassengerImportService } from './passenger-import.service';
import {
  CreatePassengerDto,
  DriverLoginDto,
  GeocodeQuery,
  PassengerAppAccessDto,
  PassengerImportOptionsDto,
  PassengerListQuery,
  RecordConsentDto,
  UpdatePassengerDto,
  VehicleProfileDto,
} from './people.dto';
import { PeopleService } from './people.service';

type Upload = { buffer: Buffer; originalname?: string } | undefined;
const UPLOAD = FileInterceptor('file', { limits: { fileSize: PASSENGER_IMPORT_MAX_BYTES, files: 1 } });

/**
 * /api/transport/passengers (doc 05 §2.2). Menu `etms_passengers` + company add-on `etms` (404 when off). Row scope and
 * projection come from people-access.ts: own company (FULL for whole-company roles, STANDARD for branch-scoped roles),
 * providers MINIMAL under an agreement granting VIEW_PASSENGER_MINIMAL, other ids 404. Optional `X-Access-Reason` is
 * recorded with sensitive-read audits (Super Admin reads, doc 10 §2.2 item 8).
 */
@Controller('transport/passengers')
@UseGuards(TransportFeatureGuard)
export class PassengersController {
  constructor(
    private readonly people: PeopleService,
    private readonly importer: PassengerImportService,
  ) {}

  @Get() @RequirePermission('etms_passengers', 'view')
  list(@Auth() ctx: AuthContext, @Query() query: PassengerListQuery, @Headers('x-access-reason') reason?: string) {
    return this.people.list(ctx, query, { reason });
  }

  @Get('geocode') @RequireAnyPermission(['etms_passengers', 'create'], ['etms_passengers', 'edit'])
  geocode(@Query() query: GeocodeQuery): Promise<GeocodeCandidate[]> {
    return this.people.geocode(query.q);
  }

  /** Dry run: validation report, nothing written. */
  @Post('import/preview') @HttpCode(200) @RequirePermission('etms_passengers', 'create') @UseInterceptors(UPLOAD)
  preview(@Auth() ctx: AuthContext, @UploadedFile() file: Upload, @Body() opts: PassengerImportOptionsDto): Promise<PassengerImportResult> {
    return this.importer.run(ctx, file, { commit: false, geocode: opts.geocode === 'true' });
  }

  /** Commit the rows without errors (or only `rows`); idempotent on (company, employee_code). */
  @Post('import/commit') @HttpCode(200) @RequirePermission('etms_passengers', 'create') @UseInterceptors(UPLOAD)
  commit(@Auth() ctx: AuthContext, @UploadedFile() file: Upload, @Body() opts: PassengerImportOptionsDto): Promise<PassengerImportResult> {
    return this.importer.run(ctx, file, { commit: true, geocode: opts.geocode === 'true', rows: opts.rows });
  }

  @Get(':id') @RequirePermission('etms_passengers', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('x-access-reason') reason?: string): Promise<PassengerDto> {
    return this.people.get(ctx, id, { reason });
  }

  @Post() @RequirePermission('etms_passengers', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreatePassengerDto): Promise<PassengerDto> {
    return this.people.create(ctx, dto);
  }

  @Patch(':id') @RequirePermission('etms_passengers', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePassengerDto): Promise<PassengerDto> {
    return this.people.update(ctx, id, dto);
  }

  /** Archive (isActive = false) and disable the passenger login; never a hard delete. */
  @Delete(':id') @RequirePermission('etms_passengers', 'delete')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PassengerDto> {
    return this.people.archive(ctx, id);
  }

  @Post(':id/app-access') @HttpCode(200) @RequirePermission('etms_passengers', 'edit')
  grantAppAccess(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PassengerAppAccessDto): Promise<PassengerAppAccessResult> {
    return this.people.grantAppAccess(ctx, id, dto);
  }

  @Delete(':id/app-access') @RequirePermission('etms_passengers', 'edit')
  revokeAppAccess(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PassengerDto> {
    return this.people.revokeAppAccess(ctx, id);
  }

  @Get(':id/consents') @RequirePermission('etms_passengers', 'view')
  consents(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('x-access-reason') reason?: string): Promise<PassengerConsentsDto> {
    return this.people.consents(ctx, id, { reason });
  }

  /** Grant / withdraw on the passenger's behalf (channel ADMIN_ON_BEHALF); corporate admin only. */
  @Post(':id/consents') @HttpCode(200) @RequirePermission('etms_passengers', 'edit')
  recordConsent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordConsentDto): Promise<PassengerConsentsDto> {
    return this.people.recordConsentOnBehalf(ctx, id, dto);
  }
}

/**
 * /api/me/transport/consent (doc 05 §2.8; shipped with E2 so consent is explicit and revocable by the passenger).
 * Menu `etms_self` + relationship check: the caller's own active profile, else 403 NOT_A_PASSENGER.
 */
@Controller('me/transport')
@UseGuards(TransportFeatureGuard)
export class MyTransportConsentController {
  constructor(private readonly people: PeopleService) {}

  @Get('consent') @RequirePermission('etms_self', 'view')
  async current(@Auth() ctx: AuthContext): Promise<PassengerConsentsDto['current']> {
    return (await this.people.myConsents(ctx)).current;
  }

  @Get('consent/history') @RequirePermission('etms_self', 'view')
  history(@Auth() ctx: AuthContext): Promise<PassengerConsentsDto> {
    return this.people.myConsents(ctx);
  }

  @Post('consent') @HttpCode(200) @RequirePermission('etms_self', 'view')
  record(@Auth() ctx: AuthContext, @Body() dto: RecordConsentDto): Promise<PassengerConsentsDto> {
    return this.people.recordMyConsent(ctx, dto, 'WEB');
  }
}

/** /api/transport/vehicles (doc 05 §2.3): seat capacity of the company's own vehicles. */
@Controller('transport/vehicles')
@UseGuards(TransportFeatureGuard)
export class TransportVehiclesController {
  constructor(private readonly fleet: FleetLinksService) {}

  @Get() @RequirePermission('objects', 'view')
  list(@Auth() ctx: AuthContext): Promise<TransportVehicleProfileDto[]> {
    return this.fleet.listVehicleProfiles(ctx);
  }

  @Get(':objectId/profile') @RequirePermission('objects', 'view')
  get(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string): Promise<TransportVehicleProfileResponse> {
    return this.fleet.getVehicleProfile(ctx, objectId);
  }

  @Put(':objectId/profile') @RequirePermission('objects', 'edit')
  put(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() dto: VehicleProfileDto): Promise<TransportVehicleProfileDto> {
    return this.fleet.putVehicleProfile(ctx, objectId, dto);
  }
}

/** /api/drivers/:id/login (doc 05 §2.3): the driver's login (Driver role template, Driver.userId). ETMS add-on only. */
@Controller('drivers')
@UseGuards(TransportFeatureGuard)
export class DriverLoginController {
  constructor(private readonly fleet: FleetLinksService) {}

  @Get(':id/login') @RequirePermission('drivers', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DriverLoginResult> {
    return this.fleet.getDriverLogin(ctx, id);
  }

  @Post(':id/login') @HttpCode(200) @RequirePermission('drivers', 'edit')
  grant(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DriverLoginDto): Promise<DriverLoginResult> {
    return this.fleet.grantDriverLogin(ctx, id, dto);
  }

  @Delete(':id/login') @RequirePermission('drivers', 'edit')
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<DriverLoginResult> {
    return this.fleet.revokeDriverLogin(ctx, id);
  }
}
