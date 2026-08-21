import { Module } from "@nestjs/common";
import { ExtractionModule } from "../verification/extraction/extraction.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

@Module({
  // Para revisar una foto sin depender del modelo: ver AiController.document().
  imports: [ExtractionModule],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
