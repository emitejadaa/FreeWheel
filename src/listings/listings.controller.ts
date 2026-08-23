import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { OptionalJwtAuthGuard } from "../auth/guards/optional-jwt-auth.guard";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { AvailabilityService } from "../availability/availability.service";
import { AvailabilityQueryDto } from "../availability/dto/availability-query.dto";
import { CreateAvailabilityBlockDto } from "../availability/dto/create-availability-block.dto";
import { CreateListingDto } from "./dto/create-listing.dto";
import { ListListingsQueryDto } from "./dto/list-listings-query.dto";
import { ReorderPhotosDto } from "./dto/reorder-photos.dto";
import { UpdateListingDto } from "./dto/update-listing.dto";
import {
  ConfirmPriceChangeDto,
  RequestPriceChangeDto,
} from "./dto/request-price-change.dto";
import { ListingsService } from "./listings.service";
import { PriceChangeService } from "./price-change.service";

@Controller("listings")
export class ListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly availabilityService: AvailabilityService,
    private readonly priceChangeService: PriceChangeService,
  ) {}

  // Publishing (and managing) listings moves vehicles and money, so every
  // listing mutation requires a fully verified account. Public browsing and
  // the owner's read-only routes stay open.
  @Post()
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() createListingDto: CreateListingDto,
  ) {
    return this.listingsService.create(user.id, createListingDto);
  }

  @Get()
  findActive(@Query() query: ListListingsQueryDto) {
    return this.listingsService.findActive(query);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.listingsService.findMine(user.id);
  }

  // Pública, pero con autenticación opcional: el dueño ve además sus propios
  // avisos en DRAFT/PAUSED (para poder abrirlos desde "Mis autos").
  @Get(":id")
  @UseGuards(OptionalJwtAuthGuard)
  findOne(
    @CurrentUser() user: CurrentUserPayload | null,
    @Param("id") id: string,
  ) {
    return this.listingsService.findOne(id, user?.id);
  }

  @Get(":id/availability")
  getAvailability(
    @Param("id") id: string,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.availabilityService.getListingAvailability(
      id,
      query.startDate,
      query.endDate,
    );
  }

  @Post(":id/availability-blocks")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  createAvailabilityBlock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: CreateAvailabilityBlockDto,
  ) {
    return this.availabilityService.createBlock(user.id, id, dto);
  }

  @Get(":id/availability-blocks")
  @UseGuards(JwtAuthGuard)
  listAvailabilityBlocks(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.availabilityService.listBlocks(user.id, id);
  }

  @Delete(":id/availability-blocks/:blockId")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  deleteAvailabilityBlock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Param("blockId") blockId: string,
  ) {
    return this.availabilityService.deleteBlock(user.id, id, blockId);
  }

  // ── Cambio de precio ──────────────────────────────────────────────────────
  // El precio no se toca con un PATCH común: hace falta confirmar con el código
  // que llega por email, no puede haber reservas en curso y hay una espera entre
  // cambios. Ver price-change.service.ts para el detalle del criterio.

  /** Estado del precio: si se puede cambiar ahora y, si no, por qué. */
  @Get(":id/price-change")
  @UseGuards(JwtAuthGuard)
  priceChangeStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.priceChangeService.status(user.id, id);
  }

  /** Paso 1: se pide el cambio y sale el código al email. */
  @Post(":id/price-change")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  requestPriceChange(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: RequestPriceChangeDto,
  ) {
    return this.priceChangeService.request(user.id, id, dto.pricePerDay);
  }

  /** Paso 2: con el código, el precio nuevo queda aplicado. */
  @Post(":id/price-change/confirm")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  confirmPriceChange(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: ConfirmPriceChangeDto,
  ) {
    return this.priceChangeService.confirm(user.id, id, dto.code);
  }

  /** Se descarta el cambio pendiente. */
  @Delete(":id/price-change")
  @UseGuards(JwtAuthGuard)
  cancelPriceChange(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
  ) {
    return this.priceChangeService.cancel(user.id, id);
  }

  /**
   * El orden de las fotos, que es lo que decide cuál es la portada.
   *
   * No va por `PATCH /listings/:id` porque las fotos no son un campo del aviso:
   * viven en MediaAsset, y lo que se guarda no es un valor sino la posición de
   * cada una. Metido ahí adentro, `update` tendría que mirar si vino "photos"
   * y desviarse a otra tabla, que es como se arman los endpoints que hacen
   * cinco cosas distintas según lo que les mandes.
   *
   * Queda declarado antes que `@Patch(":id")` por costumbre —la ruta más
   * específica primero—, aunque acá las dos tienen distinta cantidad de tramos
   * y no se pisan.
   */
  @Patch(":id/photos")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  reorderPhotos(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() dto: ReorderPhotosDto,
  ) {
    return this.listingsService.reorderPhotos(user.id, id, dto.photos);
  }

  @Patch(":id")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() updateListingDto: UpdateListingDto,
  ) {
    return this.listingsService.update(user.id, id, updateListingDto);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard, VerifiedAccountGuard)
  @RequireVerifiedAccount()
  remove(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.listingsService.remove(user.id, id);
  }
}
