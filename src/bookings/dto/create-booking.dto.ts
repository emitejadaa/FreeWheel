import { Type } from 'class-transformer';
import { IsDate, IsString, MinDate } from 'class-validator';

export class CreateBookingDto {
  @IsString()
  listingId!: string;

  @Type(() => Date)
  @IsDate()
  @MinDate(new Date('2000-01-01T00:00:00.000Z'))
  startDate!: Date;

  @Type(() => Date)
  @IsDate()
  @MinDate(new Date('2000-01-01T00:00:00.000Z'))
  endDate!: Date;
}
