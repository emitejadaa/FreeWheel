import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MediaModule } from "../media/media.module";
import { VerificationModule } from "../verification/verification.module";
import { ReviewsModule } from "../reviews/reviews.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AccountDeletionPolicy } from "./account-deletion.policy";

@Module({
  // MediaModule + VerificationModule: firmar la entrega de los documentos de
  // identidad para la revisión manual.
  // ReviewsModule: al borrar una cuenta hay que recalcular los promedios de
  // quienes habían recibido sus reseñas.
  imports: [
    PrismaModule,
    CommonModule,
    MediaModule,
    VerificationModule,
    ReviewsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AccountDeletionPolicy],
})
export class AdminModule {}
