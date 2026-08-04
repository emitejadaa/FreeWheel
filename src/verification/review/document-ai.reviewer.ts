import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CloudinaryService } from "../../media/cloudinary.service";
import { BarcodeDecoderService } from "../extraction/barcode-decoder.service";
import { DocumentOcrService } from "../extraction/document-ocr.service";
import {
  DocumentExtraction,
  DocumentSlot,
  OcrExtraction,
} from "../extraction/extraction.types";
import { parseDniPdf417 } from "../extraction/dni-pdf417.parser";
import { parseLicenseCode } from "../extraction/license-code.parser";
import { parseMrzTd1 } from "../extraction/mrz-td1.parser";
import { IdentityDocumentsService } from "../identity/identity-documents.service";
import { IdentityMatchService } from "../matching/identity-match.service";
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
 * Orquesta: descarga las cuatro imágenes desde el almacenamiento privado →
 * decodifica el PDF417 del DNI y el QR de la licencia (determinístico) → lee
 * el texto impreso con OCR → parsea MRZ y códigos → cruza todo contra sí
 * mismo y contra los datos de la cuenta (IdentityMatchService) → emite el
 * veredicto.
 *
 * Todo lo pesado corre en paralelo porque la revisión vive dentro del request
 * serverless. No decide nada por sí mismo: la política está en
 * IdentityMatchService, que es puro y testeable.
 */
@Injectable()
export class DocumentAiReviewer implements IdentityReviewer {
  readonly name = "document_ai";

  private readonly logger = new Logger(DocumentAiReviewer.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly documents: IdentityDocumentsService,
    private readonly barcodes: BarcodeDecoderService,
    private readonly ocr: DocumentOcrService,
    private readonly matcher: IdentityMatchService,
  ) {}

  async review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    const extraction = await this.extract(input);
    const report = this.matcher.match(input.profile, extraction);

    this.logger.log(
      `Identity review for user ${input.userId}: ${report.outcome} ` +
        `(${report.reasonCodes.join(", ") || "sin observaciones"})`,
    );

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
      extracted: toJson(extraction),
      matchReport: toJson(report),
      documentNumber: report.documentNumber ?? undefined,
      fullNameOnDocument,
      licenseExpiresAt: report.licenseExpiresAt
        ? new Date(`${report.licenseExpiresAt}T00:00:00.000Z`)
        : undefined,
    };
  }

  private async extract(
    input: IdentityReviewInput,
  ): Promise<DocumentExtraction> {
    const slots: DocumentSlot[] = [
      "dni_front",
      "dni_back",
      "license_front",
      "license_back",
    ];

    // Una única resolución de publicId por slot; una URL que no parsee (fila
    // vieja, dato migrado) deja ese slot sin fuente en vez de romper todo.
    const publicIds = new Map<DocumentSlot, string>();
    for (const slot of slots) {
      const url = input[SLOT_FIELDS[slot]] as string;
      const parsed = this.documents.parsePersistedUrl(url);
      if (parsed) publicIds.set(slot, parsed.publicId);
    }

    const [dniBarcodePayload, licensePayload, ocrResults] = await Promise.all([
      this.decodeFirst(publicIds.get("dni_front"), ["PDF417"]),
      this.decodeFirst(publicIds.get("license_back"), ["QRCode", "PDF417"]),
      Promise.all(
        slots.map((slot) => this.readSlot(slot, publicIds.get(slot))),
      ),
    ]);

    const ocr: DocumentExtraction["ocr"] = {};
    slots.forEach((slot, index) => {
      ocr[slot] = ocrResults[index];
    });

    return {
      dniBarcode: dniBarcodePayload ? parseDniPdf417(dniBarcodePayload) : null,
      mrz: parseMrzTd1(ocr.dni_back?.fields.mrzLines ?? []),
      licenseCode: licensePayload ? parseLicenseCode(licensePayload) : null,
      ocr,
    };
  }

  /** Prueba las variantes hasta que una devuelva un código legible. */
  private async decodeFirst(
    publicId: string | undefined,
    formats: ("PDF417" | "QRCode")[],
  ): Promise<string | null> {
    if (!publicId) return null;

    for (const transformation of BARCODE_VARIANTS) {
      try {
        const { bytes } = await this.cloudinary.download(publicId, {
          transformation,
          format: "jpg",
        });
        const [decoded] = await this.barcodes.decode(bytes, formats);
        if (decoded) return decoded.text;
      } catch (error) {
        this.logger.warn(
          `No se pudo leer el código (${transformation ?? "original"}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return null;
  }

  private async readSlot(
    slot: DocumentSlot,
    publicId: string | undefined,
  ): Promise<OcrExtraction | null> {
    if (!publicId) return null;

    try {
      const { bytes, mimeType } = await this.cloudinary.download(publicId, {
        transformation: OCR_TRANSFORMATION,
        format: "jpg",
      });
      return await this.ocr.extract(slot, bytes, mimeType);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer el documento ${slot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
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
