import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { MediaModule } from "../media/media.module";
import {
  VerificationAnalysisController,
  VerificationController,
} from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import { DocumentVerificationService } from "./identity/document-verification.service";
import { DocverifyClient } from "./identity/docverify.client";
import { IdentityMatchService } from "./identity/identity-match.service";

/**
 * Verificación de la cuenta: email, teléfono y los dos documentos de
 * identidad.
 *
 * Las fotos las LEE un servicio aparte —ver docverify-api/—, que se deploya
 * por su cuenta. `DocverifyClient` es lo único que le habla;
 * `IdentityMatchService` toma lo que ese servicio leyó y lo cruza contra los
 * datos de la cuenta, que es lo que decide si el documento se aprueba solo.
 *
 * Sin `DOCVERIFY_URL` configurada el módulo funciona igual: todo pasa por
 * revisión manual, que es como funcionaba antes. La lectura automática
 * acelera, no habilita.
 */
@Module({
  imports: [PrismaModule, CommonModule, EmailModule, SmsModule, MediaModule],
  controllers: [VerificationController, VerificationAnalysisController],
  providers: [
    VerificationService,
    IdentityDocumentsService,
    DocumentVerificationService,
    DocverifyClient,
    IdentityMatchService,
  ],
  exports: [
    VerificationService,
    IdentityDocumentsService,
    DocumentVerificationService,
  ],
})
export class VerificationModule {}
