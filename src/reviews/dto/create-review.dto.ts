import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  MAX_REVIEW_PHOTOS,
  MAX_REVIEW_TAGS,
  REVIEW_TAG_CODES,
} from "../review-tags";

export class CreateReviewDto {
  /** Puntuación de 1 a 5 estrellas. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /**
   * Características de la experiencia: RESPONDE_RAPIDO, AUTO_SUCIO, etc.
   *
   * Se valida contra la lista cerrada de review-tags.ts y no se acepta texto
   * libre: lo que se guarda tiene que ser CONTABLE para que el perfil pueda
   * decir "contesta rápido, 18 veces". Una frase escrita a mano no se cuenta y
   * además no se traduce.
   *
   * `ArrayUnique` porque la misma característica dos veces contaría doble, y el
   * tope porque veinte casillas se contestan a desgano o no se contestan.
   *
   * Que cada característica corresponda al PAPEL de quien la recibe (no se le
   * puede poner "devolvió el auto sucio" a un dueño) se controla en el servicio,
   * que es el único que sabe quién reseña a quién.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_REVIEW_TAGS)
  @IsIn(REVIEW_TAG_CODES, { each: true })
  tags?: string[];

  /**
   * HASTA DOS FOTOS de quien reseña (URLs de Cloudinary).
   *
   * Una foto del auto como quedó, o del estado en que se entregó, vale mucho
   * más que cinco estrellas: le da a quien la lee algo que mirar en vez de una
   * opinión. Y encarece inflar un perfil, que es el otro motivo por el que
   * están: escribir "todo bien" es gratis; sacar y subir fotos distintas en
   * cada reseña falsa, bastante menos.
   *
   * DOS Y NO DIEZ. Una reseña no es un álbum: con diez fotos cada una, la lista
   * de reseñas de una publicación deja de poder leerse. Y el tope es también lo
   * que mantiene la cuenta de almacenamiento bajo control.
   *
   * `ArrayUnique` porque la misma foto dos veces ocupa lugar y no agrega nada.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_REVIEW_PHOTOS)
  @IsUrl({ require_protocol: true }, { each: true })
  @MaxLength(2048, { each: true })
  photos?: string[];
}
