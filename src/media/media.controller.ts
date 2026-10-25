import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import { RegisterMediaAssetDto } from "./dto/register-media-asset.dto";
import { SignUploadDto } from "./dto/sign-upload.dto";
import { MediaService } from "./media.service";

@Controller("media")
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  /*
    EL CUPO DIARIO DE FOTOS.

    Cada firma sirve para UNA foto (ver media.service.ts: el public_id lo fija
    el servidor), así que contar las firmas es contar las fotos. Cien por día
    es mucho más de lo que sube una persona —seis avisos de seis fotos son
    treinta y seis, más la de perfil, la portada y alguna del chat— y a la vez
    deja de ser posible llenar la cuenta de Cloudinary en una tarde.

    El tope está acá y no en el navegador porque un tope en el navegador no es
    un tope: se saltea abriendo F12 y llamando al endpoint a mano. El contador
    vive en la base, lo ven todas las instancias y no se reinicia con el
    deploy.
  */
  @SensitiveRateLimit({
    name: "media.sign",
    limit: 100,
    windowSec: 24 * 60 * 60,
    by: "user",
  })
  @Post("cloudinary-signature")
  signUpload(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: SignUploadDto,
  ) {
    return this.mediaService.signUpload(user.id, dto.folder);
  }

  @Post("assets")
  registerAsset(
    @CurrentUser() user: CurrentUserPayload,
    @Body() registerMediaAssetDto: RegisterMediaAssetDto,
  ) {
    return this.mediaService.registerAsset(user.id, registerMediaAssetDto);
  }

  @Get("assets/me")
  listMine(@CurrentUser() user: CurrentUserPayload) {
    return this.mediaService.listMine(user.id);
  }
}
