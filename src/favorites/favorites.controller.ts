import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { CreateFavoriteDto } from "./dto/create-favorite.dto";
import { FavoritesService } from "./favorites.service";

// Marcar favoritos no mueve autos ni dinero: alcanza con estar logueado, no se
// exige la cuenta verificada.
@Controller("favorites")
@UseGuards(JwtAuthGuard)
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get("me")
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.favoritesService.findMine(user.id);
  }

  @Get("me/ids")
  findMyIds(@CurrentUser() user: CurrentUserPayload) {
    return this.favoritesService.findMyIds(user.id);
  }

  @Post()
  add(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.add(user.id, dto.listingId);
  }

  @Delete(":listingId")
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param("listingId") listingId: string,
  ) {
    return this.favoritesService.remove(user.id, listingId);
  }
}
