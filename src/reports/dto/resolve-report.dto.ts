import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

/** Qué hace el admin con un reporte. */
export enum ReportAction {
  /** No corresponde: se cierra sin tocar nada. */
  DISMISS = "DISMISS",
  /** Se pausa la publicación (deja de aparecer, no se borra). */
  PAUSE_LISTING = "PAUSE_LISTING",
  /** Se elimina la publicación. */
  DELETE_LISTING = "DELETE_LISTING",
  /** Se suspende la cuenta reportada. */
  SUSPEND_USER = "SUSPEND_USER",
}

export class ResolveReportDto {
  @IsEnum(ReportAction)
  action!: ReportAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
