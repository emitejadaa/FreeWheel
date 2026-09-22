import { IsIn } from "class-validator";

/**
 * Qué lado de la cédula se está por subir. Carpeta y public_id los arma el
 * servidor con el dueño del JWT y el auto de la URL: el cliente no elige nada
 * más.
 */
export class VehicleUploadSignatureDto {
  @IsIn(["front", "back"])
  side!: "front" | "back";
}
