import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AvailabilityService } from "./availability.service";

@Module({
  imports: [PrismaModule],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
