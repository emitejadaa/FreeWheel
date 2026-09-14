import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { MediaModule } from "../media/media.module";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import { DocumentVerificationService } from "./identity/document-verification.service";

/**
 * Verificación de la cuenta: email, teléfono y los dos documentos de
 * identidad.
 *
 * Los documentos se revisan A MANO. Este módulo recibe las fotos, las valida
 * como archivos (que sean nuestras, del slot correcto, de esta cuenta) y las
 * deja a disposición de un admin; no las analiza. La lectura automática de
 * documentos corre en un servicio aparte —ver docverify-api/— que se deploya
 * por su cuenta: acá no hay ningún cliente que lo llame ni configuración que
 * lo apunte.
 */
@Module({
  imports: [PrismaModule, CommonModule, EmailModule, SmsModule, MediaModule],
  controllers: [VerificationController],
  providers: [
    VerificationService,
    IdentityDocumentsService,
    DocumentVerificationService,
  ],
  exports: [
    VerificationService,
    IdentityDocumentsService,
    DocumentVerificationService,
  ],
})
export class VerificationModule {}
