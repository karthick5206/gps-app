import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsUUID } from 'class-validator';
import { CreateDeviceDto, DeviceListQuery } from '../devices/devices.dto';

export class AdminDeviceListQuery extends DeviceListQuery {
  @IsOptional() @IsUUID() companyId?: string;
}

export class CreateAdminDeviceDto extends CreateDeviceDto {
  /** Owning company; null keeps the device in platform stock. */
  @IsOptional() @IsUUID() companyId?: string | null;
}

export class UpdateAdminDeviceDto extends PartialType(CreateAdminDeviceDto) {}
