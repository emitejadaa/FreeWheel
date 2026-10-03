import { IsIn, IsString } from "class-validator";
import { QuestionsService } from "../questions.service";

/**
 * "Se preguntó esto".
 *
 * El id se valida contra la lista cerrada del servicio y no con un IsString a
 * secas: la ruta es pública, y una ruta pública que escribe la fila que le
 * pidan es una tabla que se llena de basura. Lo que no está en la lista no
 * llega ni al servicio.
 */
export class AiQuestionAskedDto {
  @IsString()
  @IsIn(QuestionsService.PERMITIDAS as unknown as string[])
  questionId!: string;
}
