import { Module } from "@nestjs/common";
import { BarcodeDecoderService } from "./barcode-decoder.service";
import { CodeExtractionService } from "./code-extraction.service";
import { DocumentPrecheckService } from "./document-precheck.service";

/**
 * Lo que se puede leer de un documento SIN preguntarle a ningún modelo:
 * decodificar los códigos impresos y sacar conclusiones de lo que dicen.
 *
 * Es un módulo hoja a propósito (no importa nada): así lo pueden usar tanto la
 * revisión de identidad como el proxy de IA sin que los módulos queden
 * importándose en círculo.
 */
@Module({
  providers: [
    BarcodeDecoderService,
    CodeExtractionService,
    DocumentPrecheckService,
  ],
  exports: [
    BarcodeDecoderService,
    CodeExtractionService,
    DocumentPrecheckService,
  ],
})
export class ExtractionModule {}
