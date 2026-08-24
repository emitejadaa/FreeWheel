import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { BadRequestException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { ConfirmCodeDto } from "./dto/confirm-code.dto";
import { InspectDocumentDto } from "./dto/inspect-document.dto";
import { SubmitDocumentDto } from "./dto/submit-document.dto";
import { UploadSignatureDto } from "./dto/upload-signature.dto";
import { DocumentVerificationService } from "./identity/document-verification.service";
import type { DocumentKind } from "./identity/identity-documents.service";
import { VerificationService } from "./verification.service";

/** ":document" de la URL → tipo interno. Cualquier otra cosa es 400. */
function parseKind(document: string): DocumentKind {
  if (document === "dni" || document === "license") return document;
  throw new BadRequestException('El documento debe ser "dni" o "license"');
}

@Controller("verification")
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly documentVerification: DocumentVerificationService,
  ) {}

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
   * Firma la subida de UN archivo (documento + lado). El cliente sube el
   * archivo directo a Cloudinary con estos params: los bytes nunca pasan
   * por el backend y el asset queda privado.
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

  /**
   * Diagnostica UNA url subida, sin verificar nada ni gastar los 5 intentos
   * del submit. Responde 200 siempre: `ok` dice si serviría, y si no, `error`
   * dice exactamente qué chequeo falló, qué se esperaba y qué llegó.
   */
  @Throttle({ default: { limit: 30, ttl: 300_000 } })
  @Post("identity/inspect-url")
  inspectDocumentUrl(
    @CurrentUser() user: CurrentUserPayload,
    @Body() inspectDocumentDto: InspectDocumentDto,
  ) {
    return this.documentVerification.inspectUrl(user.id, inspectDocumentDto);
  }

  /**
   * Verifica UN documento (dni o license) con sus dos fotos. Corre el
   * verificador Python y la comparación en el momento: la respuesta ya trae
   * el veredicto (APPROVED/FAILED) con sus motivos. DNI y licencia son
   * flujos separados: se pueden mandar juntos (dos requests) o cada uno
   * cuando el usuario quiera.
   */
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post("identity/:document/submit")
  submitDocument(
    @CurrentUser() user: CurrentUserPayload,
    @Param("document") document: string,
    @Body() submitDocumentDto: SubmitDocumentDto,
  ) {
    return this.documentVerification.submit(
      user.id,
      parseKind(document),
      submitDocumentDto,
    );
  }

  /** Pide que un admin revise a mano el último resultado FAILED. */
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  @Post("identity/:document/request-review")
  requestManualReview(
    @CurrentUser() user: CurrentUserPayload,
    @Param("document") document: string,
  ) {
    return this.documentVerification.requestManualReview(
      user.id,
      parseKind(document),
    );
  }

  /** Estado de los dos flujos de documentos del usuario. */
  @Get("identity/me")
  getMyIdentity(@CurrentUser() user: CurrentUserPayload) {
    return this.documentVerification.getMyDocuments(user.id);
  }
}
