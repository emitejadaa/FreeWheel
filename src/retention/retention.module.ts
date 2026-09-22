import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MediaModule } from "../media/media.module";
import { RetentionService } from "./retention.service";

@Module({
  imports: [PrismaModule, MediaModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
