import { Module } from "@nestjs/common";
import { ListingsModule } from "../listings/listings.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FavoritesController } from "./favorites.controller";
import { FavoritesService } from "./favorites.service";

@Module({
  imports: [PrismaModule, ListingsModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
})
export class FavoritesModule {}
