import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequireVerifiedAccount } from "../common/decorators/require-verified-account.decorator";
import { VerifiedAccountGuard } from "../common/guards/verified-account.guard";
import { SensitiveRateLimit } from "../common/rate-limit/sensitive-rate-limit.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { clientIp, clientUserAgent } from "../common/utils/client-ip.util";
import { SubmitVehicleVerificationDto } from "./dto/submit-vehicle-verification.dto";
import { VehicleUploadSignatureDto } from "./dto/vehicle-upload-signature.dto";
import { VehicleVerificationService } from "./vehicle-verification.service";

/**
 * LA VERIFICACIÓN DE UN AUTO, DEL LADO DE SU DUEÑO.
 *
 * Todo exige cuenta verificada, también la lectura: la cédula prueba que el
 * auto es de alguien, y eso solo tiene sentido si ya sabemos quién es ese
 * alguien. Una cuenta sin verificar declarando "soy el titular" no prueba nada,
 * porque todavía no hay contra qué comparar el nombre ni el DNI.
 */
@Controller("vehicles/:vehicleId/verification")
@UseGuards(JwtAuthGuard, VerifiedAccountGuard)
@RequireVerifiedAccount()
export class VehicleVerificationController {
  constructor(private readonly verification: VehicleVerificationService) {}

  /**
   * Firma la subida de UN lado de la cédula. El archivo va directo a
   * Cloudinary: los bytes nunca pasan por el backend y el asset queda privado.
   */
  @Post("upload-signature")
  @SensitiveRateLimit({
    name: "vehicle-verification.upload-signature",
    limit: 20,
    windowSec: 900,
    by: "user",
  })
  signUpload(
    @CurrentUser() user: CurrentUserPayload,
    @Param("vehicleId") vehicleId: string,
    @Body() dto: VehicleUploadSignatureDto,
  ) {
    return this.verification.signUpload(user.id, vehicleId, dto.side);
  }

  /**
   * Envía (o reenvía) la cédula y los datos del seguro. El límite es por
   * persona y generoso para corregir un dato mal cargado, pero no para probar
   * patentes o DNI a ver cuál pasa.
   */
  @Post()
  @SensitiveRateLimit({
    name: "vehicle-verification.submit",
    limit: 10,
    windowSec: 3600,
    by: "user",
  })
  submit(
    @CurrentUser() user: CurrentUserPayload,
    @Param("vehicleId") vehicleId: string,
    @Body() dto: SubmitVehicleVerificationDto,
    @Req() req: Request,
  ) {
    return this.verification.submit(user.id, vehicleId, dto, {
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
    });
  }

  /** Estado de la verificación, con los datos sensibles enmascarados. */
  @Get()
  @Header("Cache-Control", "no-store")
  get(
    @CurrentUser() user: CurrentUserPayload,
    @Param("vehicleId") vehicleId: string,
  ) {
    return this.verification.getForOwner(user.id, vehicleId);
  }
}
