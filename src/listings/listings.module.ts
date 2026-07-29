import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { EmailModule } from "../email/email.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { PriceChangeService } from "./price-change.service";

@Module({
  imports: [PrismaModule, AvailabilityModule, EmailModule],
  controllers: [ListingsController],
  providers: [ListingsService, PriceChangeService],
  exports: [ListingsService],
})
export class ListingsModule {}
