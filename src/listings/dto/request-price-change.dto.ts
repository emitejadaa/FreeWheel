import { Type } from "class-transformer";
import { IsNumber, IsString, Length, Min } from "class-validator";

export class RequestPriceChangeDto {
  /** Precio por día nuevo. Se aplica recién al confirmar con el código. */
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  pricePerDay!: number;
}

export class ConfirmPriceChangeDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
