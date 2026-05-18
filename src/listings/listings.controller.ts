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

  @Post()
  @UseGuards(JwtAuthGuard)
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

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.listingsService.findOne(id);
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  deleteAvailabilityBlock(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Param("blockId") blockId: string,
  ) {
    return this.availabilityService.deleteBlock(user.id, id, blockId);
  }

  @Patch(":id")
  @UseGuards(JwtAuthGuard)
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param("id") id: string,
    @Body() updateListingDto: UpdateListingDto,
  ) {
    return this.listingsService.update(user.id, id, updateListingDto);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard)
  remove(@CurrentUser() user: CurrentUserPayload, @Param("id") id: string) {
    return this.listingsService.remove(user.id, id);
  }
}
