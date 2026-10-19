import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AntifraudeModule } from "../antifraude/antifraude.module";
import { ReviewsController } from "./reviews.controller";
import { ReviewsService } from "./reviews.service";

@Module({
  // AntifraudeModule entra por los topes de reseñas: una reputación que se
  // puede fabricar deja sin sentido a todo lo demás.
  imports: [PrismaModule, AntifraudeModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
