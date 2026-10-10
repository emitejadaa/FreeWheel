import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersController } from "./users.controller";
import { VerificationModule } from "../verification/verification.module";

@Module({
  // VerificationModule aporta DocumentVerificationService: con un documento
  // aprobado, los datos de identidad del perfil quedan bloqueados.
  imports: [PrismaModule, VerificationModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
