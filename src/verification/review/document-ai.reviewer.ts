import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CloudinaryService } from "../../media/cloudinary.service";
import { DocumentSlot } from "../extraction/extraction.types";
import { IdentityDocumentsService } from "../identity/identity-documents.service";
import {
  IdentityVerificationPipeline,
  SlotImages,
} from "../pipeline/identity-verification.pipeline";
import {
  IdentityReviewer,
  IdentityReviewInput,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

/**
 * Variantes de transformación con las que se reintenta el decodificado del
 * código: la foto original suele alcanzar, pero ampliar y pasar a escala de
 * grises rescata fotos con poca resolución o brillo. Las hace Cloudinary al
 * entregar la imagen, así no hace falta una librería de imágenes en el bundle.
 */
const BARCODE_VARIANTS = [
  "c_limit,w_2000,q_auto:best",
  undefined,
  "c_limit,w_2000,e_grayscale,e_contrast:30,q_auto:best",
];

/** Para el OCR alcanza una imagen más liviana (y entra en el límite del modelo). */
const OCR_TRANSFORMATION = "c_limit,w_1600,q_auto:good,f_jpg";

const SLOT_FIELDS: Record<DocumentSlot, keyof IdentityReviewInput> = {
  dni_front: "dniFrontUrl",
  dni_back: "dniBackUrl",
  license_front: "licenseFrontUrl",
  license_back: "licenseBackUrl",
};

/**
 * Revisión documental real (IDENTITY_REVIEW_MODE=document_ai).
 *
 * Es un ADAPTADOR: lo único que hace es decirle al pipeline cómo bajar cada
 * foto del almacenamiento privado, y traducir su resultado al veredicto que
 * espera el resto de la aplicación. Todo el trabajo —leer los códigos, leer el
 * texto, cruzar los datos, decidir— vive en el pipeline y en los tres módulos
 * que orquesta, que se pueden probar sin Cloudinary y sin base de datos.
 *
 * El rastro completo (qué se intentó, cuánto tardó, qué falló y por qué) queda
 * guardado en la columna `extracted`, que solo ven los administradores.
 */
@Injectable()
export class DocumentAiReviewer implements IdentityReviewer {
  readonly name = "document_ai";

  private readonly logger = new Logger(DocumentAiReviewer.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly documents: IdentityDocumentsService,
    private readonly pipeline: IdentityVerificationPipeline,
  ) {}

  async review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    const result = await this.pipeline.run({
      profile: input.profile,
      images: this.imagesFor(input),
    });

    const { report, extraction } = result;

    this.logger.log(
      `Identity review for user ${input.userId}: ${report.outcome} ` +
        `(${report.reasonCodes.join(", ") || "sin observaciones"}) ` +
        `en ${result.totalMs} ms`,
    );
    for (const stage of result.stages) {
      if (stage.error) {
        this.logger.warn(
          `Etapa ${stage.stage} (${stage.durationMs} ms): ${stage.error.message}`,
        );
      }
    }

    // El nombre se toma de la fuente autoritativa (PDF417 o MRZ validado), no
    // del OCR ni de lo que escribió la persona.
    const authoritative = extraction.dniBarcode ?? extraction.mrz;
    const fullNameOnDocument = authoritative
      ? `${authoritative.lastName} ${authoritative.firstName}`.trim()
      : undefined;

    return {
      outcome: report.outcome,
      reasonCodes: report.reasonCodes,
      notes: summarize(report.outcome, report.reasonCodes),
      extracted: toJson({
        ...extraction,
        trace: {
          stages: result.stages,
          totalMs: result.totalMs,
          dniCode: {
            found: extraction.dniBarcode !== null,
            source: result.dniCode.source,
            attempts: result.dniCode.attempts,
            error: result.dniCode.error,
          },
          licenseCode: {
            found: extraction.licenseCode !== null,
            source: result.licenseCode.source,
            attempts: result.licenseCode.attempts,
            error: result.licenseCode.error,
          },
          mrz: result.mrz.error ? { error: result.mrz.error } : undefined,
        },
      }),
      matchReport: toJson(report),
      documentNumber: report.documentNumber ?? undefined,
      fullNameOnDocument,
      licenseExpiresAt: report.licenseExpiresAt
        ? new Date(`${report.licenseExpiresAt}T00:00:00.000Z`)
        : undefined,
    };
  }

  /**
   * Cómo bajar cada foto. Una URL que no parsee (una fila vieja, un dato
   * migrado) deja ese slot sin fuente en vez de romper la revisión entera.
   */
  private imagesFor(
    input: IdentityReviewInput,
  ): Partial<Record<DocumentSlot, SlotImages>> {
    const images: Partial<Record<DocumentSlot, SlotImages>> = {};

    for (const slot of Object.keys(SLOT_FIELDS) as DocumentSlot[]) {
      const url = input[SLOT_FIELDS[slot]] as string;
      const parsed = this.documents.parsePersistedUrl(url);
      if (!parsed) continue;

      images[slot] = {
        codeVariants: BARCODE_VARIANTS,
        ocrVariant: OCR_TRANSFORMATION,
        load: (transformation) =>
          this.cloudinary.download(parsed.publicId, {
            transformation,
            format: "jpg",
          }),
      };
    }

    return images;
  }
}

/** Resumen corto para el admin; los detalles quedan en el matchReport. */
function summarize(outcome: string, reasonCodes: string[]): string {
  if (outcome === "approved") return "Verificación documental automática: OK";
  const reasons = reasonCodes.join(", ") || "sin detalle";
  return outcome === "rejected"
    ? `Rechazo automático: ${reasons}`
    : `Requiere revisión manual: ${reasons}`;
}

/**
 * Normaliza a JSON plano (sin Date ni undefined) para guardarlo en una
 * columna Json de Prisma.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
