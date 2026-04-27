import { ListingStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateListingDto {
  @IsString()
  vehicleId!: string;

  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsNumber()
  @IsPositive()
  pricePerDay!: number;

  @IsString()
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
  deliveryRadiusKm?: number;

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
