import { ListingStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateListingStatusDto {
  @IsEnum(ListingStatus)
  status!: ListingStatus;
}
