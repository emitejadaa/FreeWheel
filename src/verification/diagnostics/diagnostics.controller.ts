import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../../common/types/current-user.type";
import { CloudinaryService } from "../../media/cloudinary.service";
import { PrismaService } from "../../prisma/prisma.service";
import { DiagnoseCompareDto, DiagnoseDocumentDto } from "../dto/diagnose.dto";
import {
  VerificationError,
  sample,
  verificationError,
} from "../errors/verification-errors";
import { SOURCE_LABELS, FIELD_PRECEDENCE } from "../matching/field-comparison";
import { decodeImageDataUrl } from "../extraction/document-precheck.service";
import {
  identityFolder,
  IdentityDocumentsService,
} from "../identity/identity-documents.service";
import {
  HARD_FAIL_CODES,
  IdentityMatchService,
  REQUIRED_CODES,
} from "../matching/identity-match.service";
import { IdentityVerificationPipeline } from "../pipeline/identity-verification.pipeline";
import {
  buildExtractionFromDiagnoses,
  missingProfileFields,
  parseProfileInput,
} from "./diagnose-input";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Para bajar un documento ya subido con una resolución que sirva al código. */
const DIAGNOSTIC_TRANSFORMATION = "c_limit,w_2000,q_auto:best";

/**
 * DIAGNÓSTICO DE LA VERIFICACIÓN DE DOCUMENTOS
 *
 * Corre exactamente el mismo pipeline que la verificación de verdad, pero sin
 * escribir una sola fila: no cambia el estado de la cuenta, no crea
 * solicitudes y no deja registro de auditoría. Lo que devuelve es TODO —los
 * payloads crudos de los códigos, el texto que leyó el modelo con la posición
 * de cada dato, la matriz de comparación fuente por fuente, cada etapa con lo
 * que tardó y cada error con su motivo y su sugerencia—, que es lo que hace
 * falta para saber qué parte no anda.
 *
 * ESTADO ACTUAL: abierto para cualquier cuenta con sesión iniciada, porque
 * está pensado para probar. Devuelve datos personales completos del documento
 * que se le manda, así que ANTES DE PRODUCCIÓN hay que cerrarlo: exigir rol de
 * administrador (como hace GET /ai/health?probe=1) o apagarlo con una variable
 * de entorno. Mientras tanto tiene tope por minuto propio, porque cada llamada
 * gasta cuota del proveedor de IA.
 */
@Controller("verification/diagnose")
@UseGuards(JwtAuthGuard)
export class DiagnosticsController {
  constructor(
    private readonly pipeline: IdentityVerificationPipeline,
    private readonly matcher: IdentityMatchService,
    private readonly documents: IdentityDocumentsService,
    private readonly cloudinary: CloudinaryService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Todo lo que se puede leer de UNA foto: los códigos que trae y el texto que
   * está impreso. No compara nada contra nada.
   */
  @Throttle({ default: { limit: 40, ttl: 300_000 } })
  @Post("document")
  async document(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: DiagnoseDocumentDto,
  ) {
    const imagen = await this.loadImage(user.id, dto);

    const result = await this.pipeline.runSingle(
      dto.slot,
      imagen.bytes,
      imagen.mimeType,
      { withBoxes: dto.withBoxes === true },
    );

    return {
      ...result,
      source: {
        kind: imagen.kind,
        bytes: imagen.bytes.length,
        mimeType: imagen.mimeType,
      },
    };
  }

  /**
   * El cruce de todo lo extraído contra los datos del formulario.
   *
   * Los códigos se vuelven a interpretar desde su payload crudo: lo que decide
   * es el backend, no lo que mande el cliente.
   */
  @Throttle({ default: { limit: 60, ttl: 300_000 } })
  @Post("compare")
  async compare(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: DiagnoseCompareDto,
  ) {
    const extraction = buildExtractionFromDiagnoses(dto.documents);
    if (!extraction.ok) throw badRequest(extraction.error);

    const cuenta = await this.profileOf(user.id);
    const profile = parseProfileInput(dto.profile, cuenta);
    if (!profile.ok) throw badRequest(profile.error);

    const report = this.matcher.match(profile.data, extraction.data);
    const faltantes = missingProfileFields(profile.data);

    return {
      outcome: report.outcome,
      reasonCodes: report.reasonCodes,
      documentNumber: report.documentNumber,
      licenseExpiresAt: report.licenseExpiresAt,
      checks: report.checks,
      matrix: report.matrix,
      extraction: extraction.data,
      profile: {
        ...profile.data,
        dateOfBirth:
          profile.data.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        /** Sin estos datos no hay contra qué comparar el documento. */
        missing: faltantes,
        ...(faltantes.length > 0
          ? {
              warning: verificationError("PROFILE_INCOMPLETE", {
                field: faltantes.join(", "),
              }),
            }
          : {}),
      },
    };
  }

  /**
   * Las tablas con las que el front puede explicar lo que muestra: cómo se
   * llama cada fuente, qué fuente gana en cada campo, y qué códigos rechazan
   * o mandan a revisión. Así el demo no tiene que repetirlas por su cuenta.
   */
  @Get("info")
  info() {
    return {
      slots: ["dni_front", "dni_back", "license_front", "license_back"],
      sourceLabels: SOURCE_LABELS,
      fieldPrecedence: FIELD_PRECEDENCE,
      hardFailCodes: [...HARD_FAIL_CODES],
      requiredCodes: [...REQUIRED_CODES],
      maxImageBytes: MAX_IMAGE_BYTES,
      notes:
        "Un fallo de un código de hardFailCodes rechaza. Un código de " +
        "requiredCodes que no se pueda evaluar manda a revisión manual. " +
        "Todo lo demás es informativo.",
    };
  }

  /** La foto: o llega en base64, o se baja de un documento propio ya subido. */
  private async loadImage(
    userId: string,
    dto: DiagnoseDocumentDto,
  ): Promise<{ bytes: Uint8Array; mimeType: string; kind: "dataURL" | "url" }> {
    if (dto.image) {
      const bytes = decodeImageDataUrl(dto.image);
      if (!bytes) {
        throw badRequest(
          verificationError("IMAGE_NOT_A_DATA_URL", {}, sample(dto.image, 40)),
        );
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw badRequest(
          verificationError("IMAGE_TOO_LARGE", {
            bytes: bytes.length,
            limit: MAX_IMAGE_BYTES,
          }),
        );
      }
      return { bytes, mimeType: mimeOf(dto.image), kind: "dataURL" };
    }

    if (!dto.url) {
      throw badRequest(
        verificationError(
          "IMAGE_NOT_A_DATA_URL",
          {},
          'hay que mandar "image" (base64) o "url" (un documento ya subido)',
        ),
      );
    }

    const parsed = this.documents.parsePersistedUrl(dto.url);
    if (!parsed) {
      throw badRequest(
        verificationError("ASSET_URL_UNPARSEABLE", {
          sample: sample(dto.url, 60),
        }),
      );
    }
    // Solo documentos propios: la carpeta la fija el servidor con el userId.
    if (!parsed.publicId.startsWith(`${identityFolder(userId)}/`)) {
      throw new ForbiddenException(verificationError("ASSET_NOT_OWNED"));
    }

    try {
      const { bytes, mimeType } = await this.cloudinary.download(
        parsed.publicId,
        { transformation: DIAGNOSTIC_TRANSFORMATION, format: "jpg" },
      );
      return { bytes, mimeType, kind: "url" };
    } catch (error) {
      throw badRequest(
        verificationError("IMAGE_DOWNLOAD_FAILED", {
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** Los datos cargados a mano en la cuenta, que son contra los que se cruza. */
  private async profileOf(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      firstName: user?.firstName ?? "",
      lastName: user?.lastName ?? "",
      dateOfBirth: user?.dateOfBirth ?? null,
      dni: user?.dni ?? null,
      cuil: user?.cuil ?? null,
      address: user?.address ?? null,
    };
  }
}

/** El error del catálogo viaja entero: código, mensaje y sugerencia. */
function badRequest(error: VerificationError): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: error.code,
    message: error.message,
    hint: error.hint,
    ...(error.detail ? { detail: error.detail } : {}),
  });
}

function mimeOf(dataUrl: string): string {
  return /^data:(image\/[a-z+]+);/i.exec(dataUrl)?.[1] ?? "image/jpeg";
}
