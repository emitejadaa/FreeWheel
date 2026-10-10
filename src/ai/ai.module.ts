import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { QuestionsService } from "./questions.service";

@Module({
  // PrismaModule entra por el contador de preguntas sugeridas
  // (questions.service.ts); MediaModule, para validar que el audio a
  // transcribir sea de nuestro Cloudinary.
  imports: [PrismaModule, MediaModule],
  controllers: [AiController],
  providers: [AiService, QuestionsService],
  exports: [AiService],
})
export class AiModule {}
