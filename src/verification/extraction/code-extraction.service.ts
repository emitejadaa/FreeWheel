import { Injectable } from "@nestjs/common";
import {
  ParseResult,
  VerificationError,
  sample,
  verificationError,
} from "../errors/verification-errors";
import {
  BarcodeDecoderService,
  DecodedBarcode,
  IdentityBarcodeFormat,
} from "./barcode-decoder.service";
import { DniBarcodeData, tryParseDniPdf417 } from "./dni-pdf417.parser";
import { DocumentSlot } from "./extraction.types";
import { LicenseCodeData, tryParseLicenseCode } from "./license-code.parser";

/** Cada pasada del lector sobre una imagen, con lo que salió de ella. */
export interface BarcodeAttempt {
  slot: DocumentSlot;
  /** La transformación de Cloudinary probada, u "original". */
  variant: string;
  formats: IdentityBarcodeFormat[];
  imageBytes: number;
  durationMs: number;
  /** Qué códigos aparecieron, sin volcar el payload entero. */
  found: { format: IdentityBarcodeFormat; length: number; preview: string }[];
  /** Si alguno de esos códigos era el que se estaba buscando. */
  accepted: boolean;
  error?: VerificationError;
}

/** Un código leído y lo que se pudo hacer con él. */
export interface InspectedCode {
  format: IdentityBarcodeFormat;
  /** El payload CRUDO. Es la única forma de reconocer formatos nuevos. */
  payload: string;
  kind: "dni_pdf417" | "license_code" | "unknown";
  dni?: DniBarcodeData;
  license?: LicenseCodeData;
  errors: VerificationError[];
  warnings: VerificationError[];
}

/** Todo lo que se pudo leer de UNA foto. */
export interface DocumentCodesRead {
  slot: DocumentSlot;
  attempts: BarcodeAttempt[];
  codes: InspectedCode[];
  durationMs: number;
  /** Presente solo cuando no apareció ningún código. */
  error?: VerificationError;
}

/** El resultado de buscar UN código concreto entre varias fotos y variantes. */
export interface CodeExtraction<T> {
  data: T | null;
  payload: string | null;
  source: {
    slot: DocumentSlot;
    variant: string;
    format: IdentityBarcodeFormat;
  } | null;
  attempts: BarcodeAttempt[];
  warnings: VerificationError[];
  /** Presente solo cuando `data` es null. */
  error?: VerificationError;
  durationMs: number;
}

/**
 * De dónde sacar los bytes de una foto. Se pasa como función para que este
 * servicio no sepa nada de Cloudinary: en producción baja de ahí, en los tests
 * y en el diagnóstico los bytes ya están en memoria.
 */
export interface SlotImageSource {
  slot: DocumentSlot;
  /** Variantes a probar, en orden. `undefined` es la imagen original. */
  variants: (string | undefined)[];
  load(
    variant: string | undefined,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

const DNI_FORMATS: IdentityBarcodeFormat[] = ["PDF417"];
const LICENSE_FORMATS: IdentityBarcodeFormat[] = ["QRCode", "PDF417"];

/**
 * MÓDULO 2 · lectura de los códigos impresos, sin una sola llamada a un modelo.
 *
 * El PDF417 del DNI lo imprime el RENAPER y lo lee un decodificador: es la
 * fuente más confiable del pipeline y no depende de ningún proveedor externo.
 * Este servicio se ocupa de encontrarlo —probando variantes de la imagen y
 * las dos caras del documento— y de dejar registrado CADA intento, para que
 * cuando no aparezca se pueda decir "se probaron 6 combinaciones y en ninguna
 * había un PDF417" en vez de devolver un null mudo.
 *
 * El PDF417 del DNI está en el frente y el código de la licencia en el dorso,
 * pero los dos se buscan igual en la otra cara: hay ejemplares que los traen
 * del otro lado, y dar por sentada la cara dejaba a esos documentos sin ancla.
 */
@Injectable()
export class CodeExtractionService {
  constructor(private readonly barcodes: BarcodeDecoderService) {}

  /** El PDF417 del RENAPER, buscado en las fotos que se le pasen. */
  extractDniCode(
    sources: SlotImageSource[],
  ): Promise<CodeExtraction<DniBarcodeData>> {
    return this.search(sources, DNI_FORMATS, tryParseDniPdf417);
  }

  /**
   * El código de la licencia. Descarta el PDF417 de un DNI: si alguien
   * fotografió el documento equivocado, ese código no es el de la licencia.
   */
  extractLicenseCode(
    sources: SlotImageSource[],
  ): Promise<CodeExtraction<LicenseCodeData>> {
    return this.search(sources, LICENSE_FORMATS, (payload) => {
      if (tryParseDniPdf417(payload).ok) {
        return {
          ok: false as const,
          error: verificationError("DNI_PDF417_MALFORMED", {
            sample: sample(payload, 40),
          }),
        };
      }
      return tryParseLicenseCode(payload);
    });
  }

  /**
   * Todo lo que tenga UNA foto ya cargada en memoria, sin buscar nada en
   * particular. Es lo que necesita el diagnóstico: mostrar el payload crudo de
   * cualquier código que aparezca, sea del documento que sea.
   */
  async readCodes(
    slot: DocumentSlot,
    bytes: Uint8Array,
  ): Promise<DocumentCodesRead> {
    const started = Date.now();
    const formats: IdentityBarcodeFormat[] = ["PDF417", "QRCode"];
    const { attempt, codes } = await this.decodeOnce(
      {
        slot,
        variants: [undefined],
        load: () => Promise.resolve({ bytes, mimeType: "image/jpeg" }),
      },
      undefined,
      formats,
      bytes,
    );

    const inspected = codes.map((code) => inspect(code, slot));
    attempt.accepted = inspected.some((code) => code.kind !== "unknown");

    return {
      slot,
      attempts: [attempt],
      codes: inspected,
      durationMs: Date.now() - started,
      ...(codes.length === 0
        ? {
            error: verificationError("BARCODE_NOT_FOUND", {
              slot,
              formats,
              variants: 1,
            }),
          }
        : {}),
    };
  }

  /** Recorre fotos × variantes hasta que `accept` dé por bueno un payload. */
  private async search<T>(
    sources: SlotImageSource[],
    formats: IdentityBarcodeFormat[],
    accept: (payload: string) => ParseResult<T>,
  ): Promise<CodeExtraction<T>> {
    const started = Date.now();
    const attempts: BarcodeAttempt[] = [];

    for (const source of sources) {
      for (const variant of source.variants) {
        const loaded = await this.load(source, variant);
        if (!loaded.bytes) {
          attempts.push({
            slot: source.slot,
            variant: variantName(variant),
            formats,
            imageBytes: 0,
            durationMs: loaded.durationMs,
            found: [],
            accepted: false,
            error: loaded.error,
          });
          continue;
        }

        const { attempt, codes } = await this.decodeOnce(
          source,
          variant,
          formats,
          loaded.bytes,
        );
        attempts.push(attempt);

        for (const code of codes) {
          const parsed = accept(code.text);
          if (!parsed.ok) continue;

          attempt.accepted = true;
          return {
            data: parsed.data,
            payload: code.text,
            source: {
              slot: source.slot,
              variant: variantName(variant),
              format: code.format,
            },
            attempts,
            warnings: parsed.warnings,
            durationMs: Date.now() - started,
          };
        }
      }
    }

    return {
      data: null,
      payload: null,
      source: null,
      attempts,
      warnings: [],
      error: verificationError("BARCODE_NOT_FOUND", {
        slot: sources.map((source) => source.slot).join(" y ") || undefined,
        formats,
        variants: attempts.length,
      }),
      durationMs: Date.now() - started,
    };
  }

  private async load(
    source: SlotImageSource,
    variant: string | undefined,
  ): Promise<{
    bytes?: Uint8Array;
    durationMs: number;
    error?: VerificationError;
  }> {
    const started = Date.now();
    try {
      const { bytes } = await source.load(variant);
      return { bytes, durationMs: Date.now() - started };
    } catch (error) {
      return {
        durationMs: Date.now() - started,
        error: verificationError("IMAGE_DOWNLOAD_FAILED", {
          slot: source.slot,
          cause: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  private async decodeOnce(
    source: SlotImageSource,
    variant: string | undefined,
    formats: IdentityBarcodeFormat[],
    bytes: Uint8Array,
  ): Promise<{ attempt: BarcodeAttempt; codes: DecodedBarcode[] }> {
    const started = Date.now();
    let codes: DecodedBarcode[] = [];
    let error: VerificationError | undefined;

    try {
      codes = await this.barcodes.decode(bytes, formats);
    } catch (cause) {
      error = verificationError("BARCODE_DECODER_FAILED", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    return {
      attempt: {
        slot: source.slot,
        variant: variantName(variant),
        formats,
        imageBytes: bytes.length,
        durationMs: Date.now() - started,
        found: codes.map((code) => ({
          format: code.format,
          length: code.text.length,
          preview: sample(code.text, 24),
        })),
        accepted: false,
        ...(error ? { error } : {}),
      },
      codes,
    };
  }
}

function variantName(variant: string | undefined): string {
  return variant ?? "original";
}

/** Qué es cada código que apareció, con el motivo cuando no se sabe. */
function inspect(code: DecodedBarcode, slot: DocumentSlot): InspectedCode {
  const base = { format: code.format, payload: code.text };

  const asDni = tryParseDniPdf417(code.text);
  if (asDni.ok) {
    return {
      ...base,
      kind: "dni_pdf417",
      dni: asDni.data,
      errors: [],
      warnings: asDni.warnings,
    };
  }

  const asLicense = tryParseLicenseCode(code.text);
  const datosDeLicencia = asLicense.ok && asLicense.data.parsed;

  // Un código en una foto de la licencia que no es el PDF417 de un DNI ES el
  // código de la licencia, aunque su contenido sea opaco: casi todas las
  // jurisdicciones imprimen ahí un link de validación y nada más. Decir
  // "desconocido" en ese caso manda a buscar un problema que no existe.
  if (datosDeLicencia || slot.startsWith("license")) {
    return {
      ...base,
      kind: "license_code",
      ...(asLicense.ok ? { license: asLicense.data } : {}),
      errors: [],
      warnings: asLicense.ok ? asLicense.warnings : [],
    };
  }

  // En una foto del DNI, lo que importa es por qué no se pudo leer como DNI.
  return {
    ...base,
    kind: "unknown",
    errors: [asDni.error],
    warnings: asLicense.ok ? asLicense.warnings : [],
  };
}
