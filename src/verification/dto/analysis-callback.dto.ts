import { IsObject, IsOptional, IsString } from "class-validator";

/**
 * El aviso que manda la API de lectura cuando terminó de analizar un documento.
 *
 * `resultado` NO se valida campo por campo a propósito. Es el contrato de otro
 * servicio, con una estructura profunda que cambia cuando se agrega un
 * documento o un origen de lectura: replicarla acá en decoradores significaría
 * que agregar un campo del otro lado rompe este endpoint hasta que alguien se
 * acuerde de tocar este archivo. Quien de verdad lo interpreta es
 * IdentityMatchService, que lee lo que conoce e ignora el resto —y con un
 * resultado vacío o raro produce un informe sin datos, que es el camino de
 * revisión manual, no una excepción.
 *
 * Lo que sí protege este endpoint es QUIÉN llama: el token de un solo uso del
 * header. Sin eso, validar la forma del cuerpo no serviría de nada.
 */
export class AnalysisCallbackDto {
  /** El id de la fila, tal como se lo pasamos. Solo para los logs. */
  @IsOptional()
  @IsString()
  referencia?: string;

  @IsObject()
  resultado!: Record<string, unknown>;
}
