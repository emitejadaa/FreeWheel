import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { MediaModule } from "../media/media.module";
import { AiModule } from "../ai/ai.module";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import { BarcodeDecoderService } from "./extraction/barcode-decoder.service";
import { DocumentOcrService } from "./extraction/document-ocr.service";
import { IdentityMatchService } from "./matching/identity-match.service";
import { IdentityReviewService } from "./review/identity-review.service";
import { IDENTITY_REVIEWER } from "./review/identity-reviewer.interface";
import type { IdentityReviewer } from "./review/identity-reviewer.interface";
import { AutoApproveReviewer } from "./review/auto-approve.reviewer";
import { DocumentAiReviewer } from "./review/document-ai.reviewer";
import { ManualReviewer } from "./review/manual.reviewer";

const REQUIRED_DOCUMENT_AI_ENV = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "GROQ_API_KEY",
];

/**
 * Modo de revisión de identidad:
 * - document_ai: revisión documental real (producción).
 * - manual: nada se aprueba solo; decide un admin.
 * - auto_approve: aprueba todo (solo desarrollo y tests).
 *
 * Un modo mal escrito o sin credenciales falla al arrancar, no en la primera
 * verificación: mismo criterio que el guard de claves de Stripe.
 */
/** Exportada para poder testear el guard de arranque sin levantar la app. */
export function resolveIdentityReviewer(
  config: ConfigService,
  documentAi: DocumentAiReviewer,
): IdentityReviewer {
  const mode = (
    config.get<string>("IDENTITY_REVIEW_MODE") ?? "auto_approve"
  ).toLowerCase();

  if (mode === "manual") return new ManualReviewer();

  if (mode === "document_ai") {
    const missing = REQUIRED_DOCUMENT_AI_ENV.filter(
      (key) => !config.get<string>(key),
    );
    if (missing.length > 0) {
      throw new Error(
        `IDENTITY_REVIEW_MODE=document_ai requiere ${missing.join(", ")}`,
      );
    }
    return documentAi;
  }

  if (mode !== "auto_approve") {
    throw new Error(
      `Unknown IDENTITY_REVIEW_MODE "${mode}" ` +
        `(use "document_ai", "manual" or "auto_approve")`,
    );
  }
  return new AutoApproveReviewer();
}

const identityReviewer: Provider = {
  provide: IDENTITY_REVIEWER,
  inject: [ConfigService, DocumentAiReviewer],
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
  ],
  controllers: [VerificationController],
  providers: [
    VerificationService,
    IdentityDocumentsService,
    BarcodeDecoderService,
    DocumentOcrService,
    IdentityMatchService,
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
