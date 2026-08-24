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
  DocverifyModeInfo,
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
 *   el matcher del backend decide.
 * - "manual": nada se aprueba solo; todo entra a la cola del admin.
 * - "auto_approve": aprueba todo. Solo desarrollo y tests.
 *
 * CUANDO SE PIDIÓ "auto" Y NO SE PUEDE, EL MODO EFECTIVO ES "unavailable",
 * NO "manual". Son dos cosas distintas: "manual" es alguien decidiendo revisar
 * a mano; "unavailable" es este servidor sin con qué verificar. Antes las dos
 * caían en "manual" y el resultado era que en un servidor sin Python —Vercel
 * serverless— toda submission quedaba en MANUAL_REVIEW sin que nadie la
 * pidiera, y la siguiente se rechazaba. Ahora "unavailable" termina en FAILED
 * con el motivo puesto, y la persona puede reenviar o pedir revisión manual.
 *
 * El motivo de la degradación viaja en el objeto y sale por `/health/env`:
 * antes el servidor decía "auto" en el diagnóstico y se comportaba como otro.
 *
 * Exportada para poder testear el arranque sin levantar la app.
 */
export async function resolveDocverifyMode(
  config: ConfigService,
  docverify: PythonDocverifyService,
): Promise<DocverifyModeInfo> {
  const logger = new Logger("DocverifyMode");
  const configured = config.get<string>("DOCVERIFY_MODE")?.trim();
  const mode = (configured || "auto").toLowerCase();

  if (mode === "manual" || mode === "auto_approve") {
    return { mode, configured: mode, degradedReason: null };
  }

  if (mode !== "auto") {
    throw new Error(
      `Unknown DOCVERIFY_MODE "${mode}" (use "auto", "manual" or "auto_approve")`,
    );
  }

  const degradado = (degradedReason: string): DocverifyModeInfo => {
    logger.warn(
      `La verificación automática NO va a correr en este servidor: ` +
        `${degradedReason}. Las submissions van a quedar FAILED con ese ` +
        "motivo; se pueden reenviar o mandar a revisión manual.",
    );
    return { mode: "unavailable", configured: "auto", degradedReason };
  };

  // Sin poder bajar las fotos del storage no hay nada que analizar.
  const missing = REQUIRED_AUTO_ENV.filter((key) => !config.get<string>(key));
  if (missing.length > 0) {
    const detalle = `faltan las credenciales del storage (${missing.join(", ")})`;
    // Pedido explícito y sin con qué cumplirlo: se corta al arrancar en vez de
    // publicar una API que dice que verifica y no verifica.
    if (configured) {
      throw new Error(`DOCVERIFY_MODE=auto requiere ${missing.join(", ")}`);
    }
    return degradado(detalle);
  }

  if (!(await docverify.available())) {
    return degradado(docverify.unavailableReason());
  }

  return { mode: "auto", configured: "auto", degradedReason: null };
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
