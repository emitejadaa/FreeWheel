import { ListingStatus } from "@prisma/client";
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/** Hasta dónde se acepta un radio de entrega: 200 km alrededor del auto. */
export const MAX_DELIVERY_RADIUS_M = 200_000;

export class CreateListingDto {
  @IsString()
  @MinLength(1)
  vehicleId!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @IsNumber()
  @IsPositive()
  @Max(10000000)
  pricePerDay!: number;

  // ── Ubicación del auto ────────────────────────────────────────────────────
  // Los tres describen UN punto: la dirección escrita y la coordenada tienen
  // que ser el mismo lugar. El front los mantiene atados (se mueve el pin y se
  // reescribe la dirección, se escribe la dirección y se mueve el pin), así que
  // acá los tres viajan juntos y son obligatorios.
  //
  // La coordenada es obligatoria porque sin ella la publicación no aparece en
  // ninguna búsqueda por zona: entra al catálogo para no salir nunca. Un texto
  // suelto tampoco alcanza, porque "Palermo" no se puede comparar con un radio.

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  locationText!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  // ── Entrega ───────────────────────────────────────────────────────────────
  /**
   * Metros a la redonda del punto de arriba que el dueño está dispuesto a
   * recorrer para entregar el auto.
   *
   * Opcional y 0 por defecto: no ofrecer entrega es una respuesta válida y la
   * más común, y así publicar no obliga a decidir sobre algo que quizás no se
   * hace. 0 significa "se retira en el lugar", no "sin definir".
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DELIVERY_RADIUS_M)
  deliveryRadiusM?: number;

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
