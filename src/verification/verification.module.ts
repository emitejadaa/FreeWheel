import { Logger, Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { MediaModule } from "../media/media.module";
import { AiModule } from "../ai/ai.module";
import { AiService } from "../ai/ai.service";
import { ExtractionModule } from "./extraction/extraction.module";
import { DiagnosticsController } from "./diagnostics/diagnostics.controller";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import { DocumentOcrService } from "./extraction/document-ocr.service";
import { IdentityMatchService } from "./matching/identity-match.service";
import { IdentityVerificationPipeline } from "./pipeline/identity-verification.pipeline";
import { IdentityReviewService } from "./review/identity-review.service";
import { IDENTITY_REVIEWER } from "./review/identity-reviewer.interface";
import type { IdentityReviewer } from "./review/identity-reviewer.interface";
import { AiIdentityReviewer } from "./review/ai.reviewer";
import { AutoApproveReviewer } from "./review/auto-approve.reviewer";
import { DocumentAiReviewer } from "./review/document-ai.reviewer";
import { ManualReviewer } from "./review/manual.reviewer";

/**
 * Sin estas credenciales el modo document_ai no puede leer ningún documento:
 * las fotos viven en Cloudinary y sin poder bajarlas no hay nada que revisar.
 *
 * GROQ_API_KEY NO está en la lista, aunque antes sí: la clave la usa el OCR,
 * que es la parte prescindible del pipeline. El ancla de la verificación es el
 * PDF417 del DNI —un decodificador, no un modelo— cruzado contra lo que la
 * persona cargó en el formulario. Sin OCR se pierden los datos de corroboración
 * (domicilio, MRZ, vencimientos), no la verificación; exigir la clave hacía que
 * un problema con Groq dejara la revisión automática entera en manual.
 */
const REQUIRED_DOCUMENT_AI_ENV = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

/**
 * Modo de revisión de identidad (IDENTITY_REVIEW_MODE):
 * - "document_ai" (default): revisión documental completa. Decodifica el PDF417
 *   del DNI y el QR de la licencia, lee el texto impreso con OCR, valida el MRZ
 *   y el CUIL, y cruza todo contra los datos de la cuenta. El OCR es opcional:
 *   sin GROQ_API_KEY la revisión se sostiene con el PDF417 y el formulario.
 * - "ai": revisión liviana; un modelo de visión confirma que cada foto sea el
 *   documento pedido y extrae los datos visibles.
 * - "manual": nada se aprueba solo; decide un admin.
 * - "auto_approve": aprueba todo. Solo desarrollo y tests.
 *
 * Un modo mal escrito falla al arrancar. Si se pide document_ai explícitamente
 * sin credenciales también falla: pediste una revisión que no se puede hacer.
 * En cambio, si document_ai es solo el default y faltan credenciales, se cae a
 * "manual" con una advertencia: la app sigue funcionando y ninguna cuenta se
 * verifica sola, que es el lado seguro del error.
 *
 * Exportada para poder testear el arranque sin levantar la app.
 */
export function resolveIdentityReviewer(
  config: ConfigService,
  documentAi: DocumentAiReviewer,
  ai: AiService,
): IdentityReviewer {
  const logger = new Logger("IdentityReviewMode");
  const configured = config.get<string>("IDENTITY_REVIEW_MODE")?.trim();
  const mode = (configured || "document_ai").toLowerCase();

  if (mode === "manual") return new ManualReviewer();
  if (mode === "auto_approve") return new AutoApproveReviewer();
  if (mode === "ai") return new AiIdentityReviewer(ai);

  if (mode === "document_ai") {
    const missing = REQUIRED_DOCUMENT_AI_ENV.filter(
      (key) => !config.get<string>(key),
    );
    if (missing.length === 0) {
      if (!config.get<string>("GROQ_API_KEY")) {
        logger.warn(
          "Falta GROQ_API_KEY: la revisión documental sigue funcionando con el " +
            "PDF417 del DNI y los datos de la cuenta, pero sin el texto impreso " +
            "(domicilio, MRZ y vencimientos quedan sin corroborar).",
        );
      }
      return documentAi;
    }

    if (configured) {
      throw new Error(
        `IDENTITY_REVIEW_MODE=document_ai requiere ${missing.join(", ")}`,
      );
    }

    logger.warn(
      `Faltan ${missing.join(", ")}: la revisión documental automática queda ` +
        "deshabilitada y las verificaciones esperan a un admin. Cargá esas " +
        "variables para activar IDENTITY_REVIEW_MODE=document_ai.",
    );
    return new ManualReviewer();
  }

  throw new Error(
    `Unknown IDENTITY_REVIEW_MODE "${mode}" ` +
      `(use "document_ai", "ai", "manual" or "auto_approve")`,
  );
}

const identityReviewer: Provider = {
  provide: IDENTITY_REVIEWER,
  inject: [ConfigService, DocumentAiReviewer, AiService],
  useFactory: resolveIdentityReviewer,
};

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    EmailModule,
    SmsModule,
    MediaModule,
    AiModule,
    ExtractionModule,
  ],
  controllers: [VerificationController, DiagnosticsController],
  providers: [
    VerificationService,
    IdentityDocumentsService,
    DocumentOcrService,
    IdentityMatchService,
    IdentityVerificationPipeline,
    DocumentAiReviewer,
    IdentityReviewService,
    identityReviewer,
  ],
  exports: [
    VerificationService,
    IdentityDocumentsService,
    IdentityReviewService,
  ],
})
export class VerificationModule {}
