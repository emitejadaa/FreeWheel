import { ListingStatus } from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
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
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
