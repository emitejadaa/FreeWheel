import { DrivetrainType, FuelType, TransmissionType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(12)
  seats?: number;

  @IsOptional()
  @IsEnum(TransmissionType)
  transmission?: TransmissionType;

  @IsOptional()
  @IsEnum(FuelType)
  fuelType?: FuelType;

  @IsOptional()
  @IsEnum(DrivetrainType)
  drivetrain?: DrivetrainType;

  @IsOptional()
  @IsBoolean()
  bluetooth?: boolean;

  @IsOptional()
  @IsBoolean()
  rearCamera?: boolean;

  @IsOptional()
  @IsBoolean()
  parkingSensors?: boolean;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  fuelConsumptionLitersPer100Km?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(8)
  doors?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  trunkCapacityLiters?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  widthMm?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  lengthMm?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  heightMm?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  weightKg?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observations?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  horsePower?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  engineDisplacementCC?: number;
}
