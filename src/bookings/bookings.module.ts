import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { CommonModule } from "../common/common.module";
import { ContractsModule } from "../contracts/contracts.module";
import { EmailModule } from "../email/email.module";
import { PaymentsModule } from "../payments/payments.module";
import { PrismaModule } from "../prisma/prisma.module";
import { BookingsController } from "./bookings.controller";
import { BookingsService } from "./bookings.service";

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    AvailabilityModule,
    PaymentsModule,
    ContractsModule,
    EmailModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
