import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { EmailModule } from "../email/email.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleVerificationModule } from "../vehicle-verification/vehicle-verification.module";
import { AntifraudeModule } from "../antifraude/antifraude.module";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { PriceChangeService } from "./price-change.service";

@Module({
  imports: [
    PrismaModule,
    AvailabilityModule,
    EmailModule,
    VehicleVerificationModule,
    // Por el tope de publicaciones. Publicar nunca suspende una cuenta: solo
    // se frena la velocidad y le llega un aviso al panel.
    AntifraudeModule,
  ],
  controllers: [ListingsController],
  providers: [ListingsService, PriceChangeService],
  exports: [ListingsService],
})
export class ListingsModule {}
