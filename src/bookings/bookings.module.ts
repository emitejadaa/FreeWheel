import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { CommonModule } from "../common/common.module";
import { ContractsModule } from "../contracts/contracts.module";
import { EmailModule } from "../email/email.module";
import { ListingsModule } from "../listings/listings.module";
import { PaymentsModule } from "../payments/payments.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleVerificationModule } from "../vehicle-verification/vehicle-verification.module";
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
    VehicleVerificationModule,
    ListingsModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  // Lo usa JobsModule para cerrar los retiros que no pasaron. Sin exportarlo,
  // Nest no lo puede inyectar y la aplicación no arranca: es un error de
  // tiempo de ejecución que el compilador no ve.
  exports: [BookingsService],
})
export class BookingsModule {}
