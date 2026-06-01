import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { MockPaymentsProvider } from "./providers/mock-payments.provider";

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, MockPaymentsProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
