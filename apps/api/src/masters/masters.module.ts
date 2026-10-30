import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { AdminDevicesController } from './admin-devices/admin-devices.controller';
import { AdminDevicesService } from './admin-devices/admin-devices.service';
import { AuditLogsController } from './audit-logs/audit-logs.controller';
import { BranchesController } from './branches/branches.controller';
import { BranchesService } from './branches/branches.service';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { DeviceModelsController } from './device-models/device-models.controller';
import { DeviceModelsService } from './device-models/device-models.service';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { LookupsController } from './lookups/lookups.controller';
import { LookupsService } from './lookups/lookups.service';
import { MenusController } from './menus/menus.controller';
import { ObjectsController } from './objects/objects.controller';
import { ObjectsService } from './objects/objects.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { UnknownDevicesController } from './unknown-devices/unknown-devices.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { VehicleGroupsController } from './vehicle-groups/vehicle-groups.controller';
import { VehicleGroupsService } from './vehicle-groups/vehicle-groups.service';

@Module({
  imports: [HistoryModule],
  controllers: [
    BranchesController,
    UsersController,
    RolesController,
    MenusController,
    ObjectsController,
    DevicesController,
    VehicleGroupsController,
    LookupsController,
    DeviceModelsController,
    AdminDevicesController,
    CompaniesController,
    UnknownDevicesController,
    AuditLogsController,
    SettingsController,
  ],
  providers: [
    BranchesService,
    UsersService,
    RolesService,
    ObjectsService,
    DevicesService,
    VehicleGroupsService,
    LookupsService,
    DeviceModelsService,
    AdminDevicesService,
    CompaniesService,
    SettingsService,
  ],
  exports: [ObjectsService],
})
export class MastersModule {}
