import { IsArray, IsNumber, IsOptional, Max, Min } from "class-validator";

export class AiChatDto {
  @IsArray()
  messages!: unknown[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;
}
