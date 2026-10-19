import { IsIn, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Resolver un retiro en disputa: las dos partes dijeron que la otra no fue.
 *
 * ── POR QUÉ EL MOTIVO ES OBLIGATORIO Y LARGO ──────────────────────────────
 * Esto decide quién se queda con la seña sobre un hecho que nadie pudo
 * registrar. La persona que pierde tiene derecho a saber en qué se basó la
 * decisión, y la que decide tiene que poder explicarlo después.
 *
 * Diez caracteres no hacen bueno a un motivo, pero descartan el "ok" y el
 * "listo" escritos para pasar el campo. Es el mismo mínimo que la cancelación
 * administrativa, y por la misma razón.
 */
export class ResolveNoShowDto {
  /** "OWNER" si fue el dueño el que cumplió; "RENTER" si fue el otro. */
  @IsIn(["OWNER", "RENTER"], {
    message: "aFavorDe tiene que ser OWNER o RENTER",
  })
  aFavorDe!: "OWNER" | "RENTER";

  @IsString()
  @MinLength(10, {
    message:
      "Escribí en qué te basaste. Esto decide quién se queda con la seña " +
      "sobre algo que nadie pudo registrar.",
  })
  @MaxLength(500)
  reason!: string;
}
