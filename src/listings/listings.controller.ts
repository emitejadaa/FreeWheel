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
import { UpdateListingDto } from "./dto/update-listing.dto";
import { ListingsService } from "./listings.service";

@Controller("listings")
export class ListingsController {
  constructor(
    private readonly listingsService: ListingsService,
    private readonly availabilityService: AvailabilityService,
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
