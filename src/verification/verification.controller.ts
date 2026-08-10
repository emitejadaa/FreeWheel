import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { ConfirmCodeDto } from "./dto/confirm-code.dto";
import { SubmitIdentityDto } from "./dto/submit-identity.dto";
import { UploadSignatureDto } from "./dto/upload-signature.dto";
import { VerificationService } from "./verification.service";

@Controller("verification")
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post("email/request")
  requestEmail(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.requestEmailCode(user.id);
  }

  @Post("email/confirm")
  confirmEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() confirmCodeDto: ConfirmCodeDto,
  ) {
    return this.verificationService.confirmEmailCode(
      user.id,
      confirmCodeDto.code,
    );
  }

  @Post("phone/request")
  requestPhone(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.requestPhoneCode(user.id);
  }

  @Post("phone/confirm")
  confirmPhone(
    @CurrentUser() user: CurrentUserPayload,
    @Body() confirmCodeDto: ConfirmCodeDto,
  ) {
    return this.verificationService.confirmPhoneCode(
      user.id,
      confirmCodeDto.code,
    );
  }

  @Get("me/status")
  getStatus(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.getMyStatus(user.id);
  }

  /**
   * Firma la subida de UN documento (documento + lado). El cliente sube el
   * archivo directo a Cloudinary con estos params: los bytes nunca pasan por
   * el backend (límite de body de Vercel) y el asset queda privado.
   */
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @Post("identity/upload-signature")
  signIdentityUpload(
    @CurrentUser() user: CurrentUserPayload,
    @Body() uploadSignatureDto: UploadSignatureDto,
  ) {
    return this.verificationService.signIdentityUpload(
      user.id,
      uploadSignatureDto,
    );
  }

  // La revisión documental llama a servicios externos pagos: límite bajo.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post("identity/submit")
  submitIdentity(
    @CurrentUser() user: CurrentUserPayload,
    @Body() submitIdentityDto: SubmitIdentityDto,
  ) {
    return this.verificationService.submitIdentity(user.id, submitIdentityDto);
  }

  /** Reintenta la revisión de la última submission pendiente. */
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @Post("identity/review-retry")
  retryIdentityReview(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.retryIdentityReview(user.id);
  }

  @Get("identity/me")
  getMyIdentity(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.getMyIdentity(user.id);
  }
}
