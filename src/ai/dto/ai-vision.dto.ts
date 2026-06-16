import { IsString, MaxLength } from "class-validator";

export class AiVisionDto {
  @IsString()
  @MaxLength(3_000_000)
  imageDataUrl!: string;
}
