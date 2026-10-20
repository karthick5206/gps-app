import { IO_SENSOR_KINDS, IO_SENSOR_SOURCES, IoSensorKind, IoSensorSource } from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';

export class IoSensorBody {
  @IsIn(IO_SENSOR_KINDS) kind!: IoSensorKind;
  @IsBoolean() enabled!: boolean;
  @IsIn(IO_SENSOR_SOURCES) source!: IoSensorSource;
  @Matches(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, { message: 'attribute must be an attribute key such as adc1, in2 or door' }) attribute!: string;
  @IsOptional() @IsBoolean() invert?: boolean;
  @IsOptional() @IsNumber() @Min(-100) @Max(100) minV?: number | null;
  @IsOptional() @IsNumber() @Min(-100) @Max(100) maxV?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(5) hysteresisV?: number;
  @IsOptional() @IsInt() @Min(0) @Max(600) debounceSec?: number;
}

export class IoSensorsBody {
  @IsArray() @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => IoSensorBody) sensors!: IoSensorBody[];
}
