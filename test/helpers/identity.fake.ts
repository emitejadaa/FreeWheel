import {
  BarcodeDecoderService,
  DecodedBarcode,
  IdentityBarcodeFormat,
} from "../../src/verification/extraction/barcode-decoder.service";
import { DocumentOcrService } from "../../src/verification/extraction/document-ocr.service";
import {
  DocumentSlot,
  OcrExtraction,
} from "../../src/verification/extraction/extraction.types";
import { mrzCheckDigit } from "../../src/verification/extraction/mrz-td1.parser";

/**
 * Identidad sintética coherente: a partir de estos datos se generan el
 * payload del PDF417, las líneas del MRZ (con dígitos verificadores reales) y
 * lo que "lee" el OCR de cada lado. Permite ejercitar el pipeline completo en
 * E2E sin una sola foto de un documento real.
 */
export interface IdentityPersona {
  dni: string;
  firstName: string;
  lastName: string;
  /** ISO YYYY-MM-DD */
  birthDate: string;
  sex: "M" | "F";
  cuil: string;
  address: string;
  /** ISO YYYY-MM-DD */
  dniExpiry: string;
  /** ISO YYYY-MM-DD */
  licenseExpiry: string;
}

export function personaFor(
  overrides: Partial<IdentityPersona> & Pick<IdentityPersona, "dni" | "cuil">,
): IdentityPersona {
  return {
    firstName: "JUAN CARLOS",
    lastName: "PEREZ",
    birthDate: "1990-02-01",
    sex: "M",
    address: "Av. Siempre Viva 742, Springfield, CABA",
    dniExpiry: "2035-02-15",
    licenseExpiry: "2031-05-20",
    ...overrides,
  };
}

function toDdMmYyyy(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function toYyMmDd(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${year.slice(2)}${month}${day}`;
}

function pad(value: string, length: number): string {
  return value.padEnd(length, "<");
}

/** Payload del PDF417 del frente del DNI. */
export function pdf417Payload(persona: IdentityPersona): string {
  return [
    "00123456789",
    persona.lastName,
    persona.firstName,
    persona.sex,
    persona.dni,
    "A",
    toDdMmYyyy(persona.birthDate),
    "05/03/2015",
  ].join("@");
}

/** Tres líneas TD1 con dígitos verificadores válidos. */
export function mrzLines(persona: IdentityPersona): string[] {
  const documentField = pad(persona.dni, 9);
  const birth = toYyMmDd(persona.birthDate);
  const expiry = toYyMmDd(persona.dniExpiry);

  const line1 = `I<ARG${documentField}${mrzCheckDigit(documentField)}${"<".repeat(15)}`;
  const line2Head =
    `${birth}${mrzCheckDigit(birth)}${persona.sex}` +
    `${expiry}${mrzCheckDigit(expiry)}ARG${"<".repeat(11)}`;

  const compositeBase =
    line1.slice(5, 30) +
    line2Head.slice(0, 7) +
    line2Head.slice(8, 15) +
    line2Head.slice(18, 29);
  const line2 = `${line2Head}${mrzCheckDigit(compositeBase)}`;

  const names = `${persona.lastName}<<${persona.firstName.replace(/ /g, "<")}`;
  return [line1, line2, pad(names, 30)];
}

/** Lo que el OCR "lee" en cada lado para esta persona. */
export function ocrForPersona(
  persona: IdentityPersona,
): Record<DocumentSlot, OcrExtraction> {
  return {
    dni_front: {
      classifiedAs: "dni_front",
      fields: {
        apellido: persona.lastName,
        nombre: persona.firstName,
        sexo: persona.sex,
        nroDocumento: persona.dni,
        fechaNacimiento: toDdMmYyyy(persona.birthDate),
        fechaVencimiento: toDdMmYyyy(persona.dniExpiry),
      },
    },
    dni_back: {
      classifiedAs: "dni_back",
      fields: {
        domicilio: persona.address,
        cuil: persona.cuil,
        mrzLines: mrzLines(persona),
      },
    },
    license_front: {
      classifiedAs: "license_front",
      fields: {
        apellido: persona.lastName,
        nombre: persona.firstName,
        nroDocumento: persona.dni,
        domicilio: persona.address,
        fechaNacimiento: toDdMmYyyy(persona.birthDate),
        fechaVencimiento: toDdMmYyyy(persona.licenseExpiry),
      },
    },
    license_back: { classifiedAs: "license_back", fields: {} },
  };
}

/** El publicId viaja como "bytes" (ver FakeCloudinaryService.download). */
function slotFromBytes(bytes: Uint8Array): DocumentSlot | null {
  const publicId = new TextDecoder().decode(bytes);
  const slots: DocumentSlot[] = [
    "dni_front",
    "dni_back",
    "license_front",
    "license_back",
  ];
  return slots.find((slot) => publicId.includes(`/${slot}_`)) ?? null;
}

/**
 * Decodificador y OCR en memoria. Por defecto responden con la persona
 * registrada para ese usuario; los tests pueden romper un slot concreto para
 * simular un código ilegible o una foto equivocada.
 */
export class FakeIdentityExtraction {
  private readonly personas = new Map<string, IdentityPersona>();
  private readonly barcodeOverrides = new Map<DocumentSlot, string | null>();
  private readonly ocrOverrides = new Map<DocumentSlot, OcrExtraction | null>();

  /** Registra la identidad que "muestran" los documentos de un usuario. */
  register(userId: string, persona: IdentityPersona): IdentityPersona {
    this.personas.set(userId, persona);
    return persona;
  }

  breakBarcode(slot: DocumentSlot): void {
    this.barcodeOverrides.set(slot, null);
  }

  setOcr(slot: DocumentSlot, extraction: OcrExtraction | null): void {
    this.ocrOverrides.set(slot, extraction);
  }

  reset(): void {
    this.personas.clear();
    this.barcodeOverrides.clear();
    this.ocrOverrides.clear();
  }

  private personaForBytes(bytes: Uint8Array): IdentityPersona | null {
    const publicId = new TextDecoder().decode(bytes);
    for (const [userId, persona] of this.personas) {
      if (publicId.includes(`identity/${userId}/`)) return persona;
    }
    return null;
  }

  get barcodes(): BarcodeDecoderService {
    const decode = (
      bytes: Uint8Array,
      formats: IdentityBarcodeFormat[],
    ): Promise<DecodedBarcode[]> => {
      const slot = slotFromBytes(bytes);
      const persona = this.personaForBytes(bytes);
      if (!slot || !persona) return Promise.resolve([]);

      if (this.barcodeOverrides.has(slot)) {
        const override = this.barcodeOverrides.get(slot);
        if (!override) return Promise.resolve([]);
        return Promise.resolve([{ format: formats[0], text: override }]);
      }

      if (slot === "dni_front" && formats.includes("PDF417")) {
        return Promise.resolve([
          { format: "PDF417", text: pdf417Payload(persona) },
        ]);
      }
      if (slot === "license_back" && formats.includes("QRCode")) {
        return Promise.resolve([
          {
            format: "QRCode",
            text: `DNI=${persona.dni};VTO=${toDdMmYyyy(persona.licenseExpiry)}`,
          },
        ]);
      }
      return Promise.resolve([]);
    };

    return { decode } as unknown as BarcodeDecoderService;
  }

  get ocr(): DocumentOcrService {
    const extract = (
      slot: DocumentSlot,
      bytes: Uint8Array,
    ): Promise<OcrExtraction | null> => {
      if (this.ocrOverrides.has(slot)) {
        return Promise.resolve(this.ocrOverrides.get(slot) ?? null);
      }
      const persona = this.personaForBytes(bytes);
      return Promise.resolve(persona ? ocrForPersona(persona)[slot] : null);
    };

    return { extract } as unknown as DocumentOcrService;
  }
}
