import { Logger, Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { SmsModule } from "../sms/sms.module";
import { MediaModule } from "../media/media.module";
import { PythonDocverifyService } from "./docverify/python-docverify.service";
import { DocumentMatchService } from "./matching/document-match.service";
import { VerificationController } from "./verification.controller";
import { VerificationService } from "./verification.service";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import {
  DOCVERIFY_MODE,
  DocumentVerificationService,
  DocverifyMode,
} from "./identity/document-verification.service";

/**
 * Sin estas credenciales no hay verificación automática posible: las fotos
 * viven en Cloudinary y sin poder bajarlas no hay nada que analizar.
 */
const REQUIRED_AUTO_ENV = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];

/**
 * Modo de revisión de documentos (DOCVERIFY_MODE):
 * - "auto" (default): el verificador Python extrae los datos de las fotos y
 *   el matcher del backend decide. Sin Python instalado en el servidor (p.
 *   ej. serverless) o sin credenciales de Cloudinary, cae a "manual" con
 *   una advertencia: la app sigue funcionando y ninguna cuenta se verifica
 *   sola, que es el lado seguro del error. Si "auto" se pidió explícito y
 *   faltan las credenciales del storage, falla al arrancar: pediste una
 *   revisión que no se puede hacer.
 * - "manual": nada se aprueba solo; todo entra a la cola del admin.
 * - "auto_approve": aprueba todo. Solo desarrollo y tests.
 *
 * Exportada para poder testear el arranque sin levantar la app.
 */
export async function resolveDocverifyMode(
  config: ConfigService,
  docverify: PythonDocverifyService,
): Promise<DocverifyMode> {
  const logger = new Logger("DocverifyMode");
  const configured = config.get<string>("DOCVERIFY_MODE")?.trim();
  const mode = (configured || "auto").toLowerCase();

  if (mode === "manual" || mode === "auto_approve") return mode;

  if (mode === "auto") {
    const missing = REQUIRED_AUTO_ENV.filter((key) => !config.get<string>(key));
    if (missing.length > 0) {
      if (configured) {
        throw new Error(`DOCVERIFY_MODE=auto requiere ${missing.join(", ")}`);
      }
      logger.warn(
        `Faltan ${missing.join(", ")}: la verificación automática queda ` +
          "deshabilitada y los documentos esperan a un admin.",
      );
      return "manual";
    }

    if (!(await docverify.available())) {
      logger.warn(
        "El verificador Python no está disponible en este servidor " +
          "(python-verifier/.venv). La verificación automática queda " +
          "deshabilitada y los documentos esperan a un admin. Instalalo con: " +
          "cd python-verifier && python3 -m venv .venv && " +
          ".venv/bin/pip install -r requirements.txt",
      );
      return "manual";
    }

    return "auto";
  }

  throw new Error(
    `Unknown DOCVERIFY_MODE "${mode}" (use "auto", "manual" or "auto_approve")`,
  );
}

const docverifyMode: Provider = {
  provide: DOCVERIFY_MODE,
  inject: [ConfigService, PythonDocverifyService],
  useFactory: resolveDocverifyMode,
};

@Module({
  imports: [PrismaModule, CommonModule, EmailModule, SmsModule, MediaModule],
  controllers: [VerificationController],
  providers: [
    VerificationService,
    IdentityDocumentsService,
    PythonDocverifyService,
    DocumentMatchService,
    DocumentVerificationService,
    docverifyMode,
  ],
  exports: [
    VerificationService,
    IdentityDocumentsService,
    DocumentVerificationService,
  ],
})
export class VerificationModule {}
