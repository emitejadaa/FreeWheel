import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { ClaimsModule } from "../claims/claims.module";
import { RetentionModule } from "../retention/retention.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

@Module({
  imports: [PrismaModule, PaymentsModule, ClaimsModule, RetentionModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
