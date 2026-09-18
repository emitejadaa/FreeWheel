import { PhotoVisibility } from "@prisma/client";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  IsPhone,
  normalizePhone,
} from "../../common/validators/phone.validator";
import { IsCuil } from "../../common/validators/is-cuil.validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  /**
   * Teléfono argentino completo con código de país (54 9 11 3289 5416). Se
   * normaliza antes de validar, así queda guardado siempre en el mismo formato
   * sin importar cómo lo haya escrito la persona.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizePhone(value) ?? value)
  @IsPhone()
  phone?: string;

  // Identidad que carga la persona: la revisión documental la cruza contra lo
  // que dicen el DNI y la licencia. Inmutable una vez que hay un documento
  // aprobado contra ella (403 IDENTITY_FIELDS_LOCKED en el servicio).
  //
  // El domicilio ya no se pide. No se comparaba contra el documento, no
  // habilitaba nada y era el dato más sensible que guardábamos de una persona;
  // la única dirección que el sistema necesita es la del auto, y esa vive en la
  // publicación.
  @IsOptional()
  @Matches(/^\d{7,8}$/, {
    message: "dni debe tener 7 u 8 dígitos, sin puntos",
  })
  dni?: string;

  @IsOptional()
  @IsCuil()
  cuil?: string;

  /**
   * DEPRECADO: SE ACEPTA Y SE IGNORA.
   *
   * El domicilio dejó de ser un dato de la cuenta (ver el comentario de
   * arriba). Se sigue aceptando en el body para no romper el formulario de
   * perfil que ya está publicado: con `forbidNonWhitelisted` activado, un
   * campo desconocido devuelve 400, y eso habría dejado a la gente sin poder
   * guardar su perfil hasta que el front se actualizara.
   *
   * No se guarda en ninguna parte y no se devuelve. Cuando el front deje de
   * mandarlo, este campo se borra.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profilePhotoUrl?: string;

  /**
   * La misma foto SIN RECORTAR, para poder volver a encuadrarla.
   *
   * Va junto con `profilePhotoUrl` en el mismo PATCH: el recorte es lo que se
   * muestra y la original es con lo que se vuelve a encuadrar, y guardar una sin
   * la otra deja el par inconsistente. Sin esto, reencuadrar recortaba sobre el
   * recorte anterior y la foto se iba achicando sin vuelta atrás.
   */
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  profilePhotoOriginalUrl?: string;

  /**
   * Quién ve la foto de perfil: EVERYONE (cualquiera con la sesión abierta) o
   * BOOKED (solo con quien haya una reserva en común). Se elige en el perfil.
   */
  @IsOptional()
  @IsEnum(PhotoVisibility)
  profilePhotoVisibility?: PhotoVisibility;

  /**
   * Si esta persona quiere recibir avisos por mail: reservas pedidas,
   * aceptadas, pagos, entregas y devoluciones, y el aviso de mensajes sin leer.
   *
   * No apaga los mails de seguridad —el código para entrar, el de cambiar el
   * email, el link para recuperar la contraseña, el código para cambiar el
   * precio—: esos no son avisos, son la forma de poder usar la cuenta.
   */
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;
}
