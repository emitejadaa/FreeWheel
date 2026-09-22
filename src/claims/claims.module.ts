import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { PaymentsModule } from "../payments/payments.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminClaimsController, ClaimsController } from "./claims.controller";
import { ClaimsService } from "./claims.service";

@Module({
  imports: [PrismaModule, CommonModule, PaymentsModule],
  controllers: [ClaimsController, AdminClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
