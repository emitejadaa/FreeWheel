import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * El orden nuevo de las fotos de una publicación.
 *
 * Va la lista COMPLETA de URLs, no "moví la 3 a la 1". Dos razones:
 *
 *  · Quien la manda ya acomodó las fotos varias veces en la pantalla antes de
 *    soltar; mandar cada movimiento sería un pedido por pixel arrastrado.
 *  · Repetir el mismo pedido deja exactamente el mismo resultado. Con
 *    movimientos relativos, un reintento por una conexión que se cortó aplicaría
 *    el movimiento dos veces y dejaría las fotos en un orden que nadie pidió.
 *
 * El tope de 20 no es un número al azar: es el mismo que acepta el formulario de
 * publicar. Sin tope, una lista de cien mil URLs es una escritura de cien mil
 * filas que empieza con un solo pedido.
 */
export class ReorderPhotosDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(2048, { each: true })
  photos!: string[];
}
