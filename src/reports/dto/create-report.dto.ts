import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator";
import { ReportTargetType } from "@prisma/client";

export class CreateReportDto {
  @IsEnum(ReportTargetType)
  targetType!: ReportTargetType;

  /** Publicación reportada. Obligatorio cuando targetType es LISTING. */
  @IsOptional()
  @IsUUID()
  listingId?: string;

  /** Persona reportada. Obligatorio cuando targetType es USER. */
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  reason!: string;

  /** Descripción de lo que pasó. Se pide un mínimo para que sirva de algo. */
  @IsString()
  @MinLength(30)
  @MaxLength(1000)
  details!: string;
}
