import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * Una fecha de documento: `YYYY-MM-DD` y nada más.
 *
 * Sin hora y sin zona a propósito. Lo que dice un documento es un DÍA, y
 * aceptar un instante ISO completo abría la puerta a que la misma fecha
 * entrara corrida según desde dónde se cargara.
 */
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_FECHA = "debe ser una fecha en formato YYYY-MM-DD";

/**
 * LO QUE SE ENVÍA PARA VERIFICAR UN DOCUMENTO: las dos fotos Y LOS DATOS QUE
 * LA PERSONA LEE DE ESE DOCUMENTO.
 *
 * Los datos van acá y no los saca el OCR, y es el cambio de fondo de todo este
 * flujo. La lectura automática existe para decir si la foto coincide con lo
 * declarado; no para descubrir datos. Un vencimiento mal leído por una máquina
 * dejaba la cuenta verificada y a su dueño sin poder reservar, sin forma de
 * corregir un dato que no había cargado.
 *
 * Qué es obligatorio depende del documento, y eso NO se puede expresar en un
 * decorador de este DTO (el tipo viene en la URL, no en el body): lo controla
 * `DocumentVerificationService.assertDeclaredComplete`, que devuelve
 * DATOS_DEL_DOCUMENTO_FALTANTES con la lista exacta de lo que falta.
 *
 *   · dni     → expiresAt
 *   · license → expiresAt, issuedAt, licenseClass, isBeginner
 *               (+ beginnerUntil si isBeginner es true)
 */
export class SubmitDocumentDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  frontUrl!: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  backUrl!: string;

  /** Cuándo vence el documento, tal como figura en él. */
  @IsOptional()
  @IsString()
  @Matches(FECHA, { message: `expiresAt ${MENSAJE_FECHA}` })
  expiresAt?: string;

  /** Solo licencia: la fecha de otorgamiento impresa en el documento. */
  @IsOptional()
  @IsString()
  @Matches(FECHA, { message: `issuedAt ${MENSAJE_FECHA}` })
  issuedAt?: string;

  /**
   * Solo licencia: la clase, como figura en el documento ("B.1", "C.2", "A2.2").
   * Se guarda tal cual se escribió; la comparación ignora puntos y espacios.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^[A-Za-z][A-Za-z0-9. ]{0,9}$/, {
    message: "licenseClass debe ser una clase de licencia como B.1, C.2 o A2.2",
  })
  licenseClass?: string;

  /**
   * Solo licencia: si el documento tiene la leyenda de principiante.
   *
   * Es una pregunta explícita y no algo que se deduzca de la fecha de
   * otorgamiento: la leyenda la lleva impresa el documento y su dueño la puede
   * ver, y deducirla de una fecha se equivoca con cualquier renovación.
   */
  @IsOptional()
  @IsBoolean()
  isBeginner?: boolean;

  /** Solo licencia, y solo si isBeginner: hasta cuándo dura ese período. */
  @IsOptional()
  @IsString()
  @Matches(FECHA, { message: `beginnerUntil ${MENSAJE_FECHA}` })
  beginnerUntil?: string;
}
