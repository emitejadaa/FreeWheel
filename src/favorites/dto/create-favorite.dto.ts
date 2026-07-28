import { IsString, MinLength } from "class-validator";

export class CreateFavoriteDto {
  @IsString()
  @MinLength(1)
  listingId!: string;
}
