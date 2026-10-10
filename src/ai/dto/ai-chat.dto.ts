import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from "class-validator";
import { MAX_CHAT_MESSAGES } from "../ai.service";

export class AiChatDto {
  @IsArray()
  @ArrayMaxSize(MAX_CHAT_MESSAGES)
  messages!: unknown[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;
}
