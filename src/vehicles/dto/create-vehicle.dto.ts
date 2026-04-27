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
  Min,
} from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  brand!: string;

  @IsString()
  model!: string;

  @IsInt()
  @Min(1900)
  @Max(2100)
  year!: number;

  @IsOptional()
  @IsString()
  plate?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
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
  observations?: string;
}
