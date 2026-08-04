import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
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

  /**
   * PRUEBA de lo que se denuncia: fotos o capturas ya subidas (URLs).
   *
   * Es OBLIGATORIA, al menos una. Un reporte sin evidencia es la palabra de uno
   * contra la del otro y deja al admin sin nada con que decidir si pausar una
   * publicación o suspender una cuenta. El tope de 5 evita que se use como
   * depósito de archivos.
   */
  @IsArray()
  @ArrayMinSize(1, {
    message: "Tenés que adjuntar al menos una foto como prueba del reporte",
  })
  @ArrayMaxSize(5, { message: "Podés adjuntar hasta 5 fotos" })
  @IsUrl(
    { require_protocol: true, protocols: ["http", "https"] },
    { each: true },
  )
  @MaxLength(2048, { each: true })
  evidenceUrls!: string[];
}
