import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MediaModule } from "../media/media.module";
import { VerificationModule } from "../verification/verification.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  // MediaModule + VerificationModule: firmar la entrega de los documentos de
  // identidad para la revisión manual.
  imports: [PrismaModule, CommonModule, MediaModule, VerificationModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
