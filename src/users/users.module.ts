import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { PrismaModule } from "../prisma/prisma.module";
import { UsersController } from "./users.controller";
import { VerificationModule } from "../verification/verification.module";

@Module({
  // VerificationModule aporta IdentityReviewService: completar dni/cuil/
  // address desde el perfil puede destrabar la verificación automática.
  imports: [PrismaModule, VerificationModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
