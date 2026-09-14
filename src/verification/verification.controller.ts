import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import { AnalysisCallbackDto } from "./dto/analysis-callback.dto";
import { ConfirmCodeDto } from "./dto/confirm-code.dto";
import { InspectDocumentDto } from "./dto/inspect-document.dto";
import { SubmitDocumentDto } from "./dto/submit-document.dto";
import { UploadSignatureDto } from "./dto/upload-signature.dto";
import { DocumentVerificationService } from "./identity/document-verification.service";
import type { DocverifyResult } from "./identity/docverify.client";
import type { DocumentKind } from "./identity/identity-documents.service";
import { VerificationService } from "./verification.service";

/** ":document" de la URL → tipo interno. Cualquier otra cosa es 400. */
function parseKind(document: string): DocumentKind {
  if (document === "dni" || document === "license") return document;
  throw new BadRequestException('El documento debe ser "dni" o "license"');
}

/**
 * EL AVISO DE LA API QUE LEE DOCUMENTOS.
 *
 * Va en su propio controller porque es el único endpoint de verificación SIN
 * sesión: lo llama otro servidor, no un usuario, así que no hay JWT que
 * presentar. Separarlo es lo que permite que el resto de la clase siga con
 * `@UseGuards(JwtAuthGuard)` a nivel de clase —donde no se puede olvidar— en
 * lugar de tener que acordarse de ponerlo endpoint por endpoint.
 *
 * Lo que lo autentica es el token de un solo uso que le dimos a la API al
 * pedirle el análisis, y que solo ella conoce.
 */
@Controller("verification/identity")
export class VerificationAnalysisController {
  constructor(
    private readonly documentVerification: DocumentVerificationService,
  ) {}

  @Post("analysis-callback")
  applyAnalysis(
    @Headers("authorization") authorization: string | undefined,
    @Body() dto: AnalysisCallbackDto,
  ) {
    const token = /^Bearer (.+)$/.exec(authorization?.trim() ?? "")?.[1];
    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: "ANALYSIS_TOKEN_MISSING",
        message:
          "Falta el token del análisis: mandalo en el header " +
          "Authorization como «Bearer <token>».",
      });
    }
    return this.documentVerification.applyAnalysis(
      token,
      dto.resultado as unknown as DocverifyResult,
    );
  }
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
   * Envía UN documento (dni o license) con sus dos fotos. Las guarda y lo
   * deja PENDING: este backend no analiza las imágenes. El paso siguiente lo
   * da el usuario con `request-review`, que lo manda a la cola del admin.
   * DNI y licencia son flujos separados: se pueden mandar juntos (dos
   * requests) o cada uno cuando el usuario quiera.
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

  /** Manda el documento enviado a la cola de revisión de un admin. */
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

  /**
   * Cómo revisa documentos este servidor. Siempre a mano: el análisis
   * automático vive en un servicio aparte que no está conectado con este.
   */
  @Get("identity/diagnostics")
  getDiagnostics() {
    return this.documentVerification.diagnostics();
  }

  /** Estado de los dos flujos de documentos del usuario. */
  @Get("identity/me")
  getMyIdentity(@CurrentUser() user: CurrentUserPayload) {
    return this.documentVerification.getMyDocuments(user.id);
  }
}
