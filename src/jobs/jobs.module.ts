import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentsModule } from "../payments/payments.module";
import { ClaimsModule } from "../claims/claims.module";
import { RetentionModule } from "../retention/retention.module";
import { BookingsModule } from "../bookings/bookings.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

@Module({
  // BookingsModule entra por el cierre de los retiros que no pasaron.
  imports: [
    PrismaModule,
    PaymentsModule,
    ClaimsModule,
    RetentionModule,
    BookingsModule,
  ],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
