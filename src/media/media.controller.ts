import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/types/current-user.type';
import { RegisterMediaAssetDto } from './dto/register-media-asset.dto';
import { MediaService } from './media.service';

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('assets')
  registerAsset(
    @CurrentUser() user: CurrentUserPayload,
    @Body() registerMediaAssetDto: RegisterMediaAssetDto,
  ) {
    return this.mediaService.registerAsset(user.id, registerMediaAssetDto);
  }

  @Get('assets/me')
  listMine(@CurrentUser() user: CurrentUserPayload) {
    return this.mediaService.listMine(user.id);
  }
}
