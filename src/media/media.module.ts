import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CloudinaryService } from "./cloudinary.service";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [MediaService, CloudinaryService],
  exports: [MediaService, CloudinaryService],
})
export class MediaModule {}
