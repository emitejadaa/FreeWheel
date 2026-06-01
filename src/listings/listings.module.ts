import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";

@Module({
  imports: [PrismaModule, AvailabilityModule],
  controllers: [ListingsController],
  providers: [ListingsService],
})
export class ListingsModule {}
