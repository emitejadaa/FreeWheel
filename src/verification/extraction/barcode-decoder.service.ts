import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/full";

/**
 * Formatos que usa la verificación de identidad: PDF417 (frente del DNI
 * argentino) y QR (dorso de la licencia de conducir).
 */
export type IdentityBarcodeFormat = "PDF417" | "QRCode";

export interface DecodedBarcode {
  format: IdentityBarcodeFormat;
  text: string;
}

/**
 * zxing-wasm por defecto resuelve el binario WASM contra el CDN de jsDelivr
 * (una llamada de red en cada cold start serverless y un punto de falla
 * externo). Cargarlo desde node_modules lo evita; vercel.json lo incluye en el
 * bundle vía includeFiles.
 */
export function prepareZxingForNode(): void {
  const wasmPath = require.resolve("zxing-wasm/full/zxing_full.wasm");
  const buffer = readFileSync(wasmPath);
  const wasmBinary = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  prepareZXingModule({ overrides: { wasmBinary } });
}

/**
 * Decodificación determinística de códigos sobre los bytes de una imagen
 * JPEG/PNG. Nunca lanza por una imagen ilegible: devuelve lista vacía y el
 * caller lo trata como fuente UNAVAILABLE (cae a revisión manual, no a 500).
 */
@Injectable()
export class BarcodeDecoderService {
  private readonly logger = new Logger(BarcodeDecoderService.name);
  private prepared = false;

  async decode(
    imageBytes: Uint8Array,
    formats: IdentityBarcodeFormat[],
  ): Promise<DecodedBarcode[]> {
    try {
      if (!this.prepared) {
        prepareZxingForNode();
        this.prepared = true;
      }
      const results = await readBarcodes(imageBytes, {
        formats,
        tryHarder: true,
      });
      return results
        .filter((result) => result.isValid && result.text.length > 0)
        .map((result) => ({
          format: result.format as IdentityBarcodeFormat,
          text: result.text,
        }));
    } catch (error) {
      this.logger.warn(
        `Barcode decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
