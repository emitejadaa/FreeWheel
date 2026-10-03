import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { QuestionsService } from "./questions.service";

@Module({
  // PrismaModule entra por el contador de preguntas sugeridas
  // (questions.service.ts). El proxy de IA en sí no toca la base.
  imports: [PrismaModule],
  controllers: [AiController],
  providers: [AiService, QuestionsService],
  exports: [AiService],
})
export class AiModule {}
