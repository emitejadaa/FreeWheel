import { ListingStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateListingDto {
  @IsString()
  @MinLength(1)
  vehicleId!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @IsNumber()
  @IsPositive()
  @Max(10000000)
  pricePerDay!: number;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  locationText!: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  deliveryLatitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  deliveryLongitude?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(100)
  deliveryRadiusKm?: number;

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
