import {
  BarcodeDecoderService,
  DecodedBarcode,
  IdentityBarcodeFormat,
} from "./barcode-decoder.service";
import {
  CodeExtractionService,
  SlotImageSource,
} from "./code-extraction.service";
import { DocumentSlot } from "./extraction.types";

const PDF417_DNI =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";
const QR_LICENCIA = "DNI=12345678;VTO=20/05/2031";
const QR_OPACO = "https://licencias.example.gob.ar/v/9f3c1a";

/** Bytes distintos por variante, para poder responder distinto a cada una. */
function bytesFor(slot: DocumentSlot, variant: string | undefined): Uint8Array {
  return new TextEncoder().encode(`${slot}|${variant ?? "original"}`);
}

function source(
  slot: DocumentSlot,
  variants: (string | undefined)[] = ["ampliada", undefined, "grises"],
  onLoad?: (variant: string | undefined) => void,
): SlotImageSource {
  return {
    slot,
    variants,
    load: (variant) => {
      onLoad?.(variant);
      return Promise.resolve({
        bytes: bytesFor(slot, variant),
        mimeType: "image/jpeg",
      });
    },
  };
}

/** Lector fake: responde según lo que digan los bytes (slot|variante). */
function decoder(
  respuestas: Record<string, DecodedBarcode[]> = {},
): BarcodeDecoderService {
  const decode = (bytes: Uint8Array, formats: IdentityBarcodeFormat[]) => {
    const clave = new TextDecoder().decode(bytes);
    const codes = respuestas[clave] ?? [];
    return Promise.resolve(
      codes.filter((code) => formats.includes(code.format)),
    );
  };
  return { decode } as unknown as BarcodeDecoderService;
}

/**
 * Lo que este servicio agrega sobre el decodificador pelado es el REGISTRO:
 * qué fotos miró, con qué variantes y qué encontró en cada una. Sin eso, "no
 * se pudo leer el código" no se puede distinguir de "no se buscó".
 */
describe("CodeExtractionService", () => {
  it("corta en el primer código bueno y no pide las variantes que sobran", async () => {
    const pedidas: (string | undefined)[] = [];
    const service = new CodeExtractionService(
      decoder({
        "dni_front|ampliada": [{ format: "PDF417", text: PDF417_DNI }],
      }),
    );

    const result = await service.extractDniCode([
      source("dni_front", ["ampliada", undefined, "grises"], (v) =>
        pedidas.push(v),
      ),
    ]);

    expect(result.data?.dni).toBe("12345678");
    expect(result.source).toEqual({
      slot: "dni_front",
      variant: "ampliada",
      format: "PDF417",
    });
    expect(pedidas).toEqual(["ampliada"]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].accepted).toBe(true);
  });

  it("busca en la otra cara cuando el código no está donde se esperaba", async () => {
    const service = new CodeExtractionService(
      decoder({
        "dni_back|original": [{ format: "PDF417", text: PDF417_DNI }],
      }),
    );

    const result = await service.extractDniCode([
      source("dni_front", [undefined]),
      source("dni_back", [undefined]),
    ]);

    expect(result.data?.dni).toBe("12345678");
    expect(result.source?.slot).toBe("dni_back");
  });

  it("deja registrado cada intento cuando no aparece ningún código", async () => {
    const service = new CodeExtractionService(decoder());

    const result = await service.extractDniCode([
      source("dni_front"),
      source("dni_back"),
    ]);

    expect(result.data).toBeNull();
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.map((a) => a.variant)).toEqual([
      "ampliada",
      "original",
      "grises",
      "ampliada",
      "original",
      "grises",
    ]);
    expect(result.error?.code).toBe("BARCODE_NOT_FOUND");
    expect(result.error?.message).toContain("6 variantes");
    expect(result.error?.message).toContain("dni_front y dni_back");
  });

  it("una foto que no se puede bajar no corta la búsqueda", async () => {
    const service = new CodeExtractionService(
      decoder({
        "dni_back|original": [{ format: "PDF417", text: PDF417_DNI }],
      }),
    );
    const rota: SlotImageSource = {
      slot: "dni_front",
      variants: [undefined],
      load: () => Promise.reject(new Error("almacenamiento caído")),
    };

    const result = await service.extractDniCode([
      rota,
      source("dni_back", [undefined]),
    ]);

    expect(result.data?.dni).toBe("12345678");
    expect(result.attempts[0].error?.code).toBe("IMAGE_DOWNLOAD_FAILED");
    expect(result.attempts[0].error?.message).toContain("almacenamiento caído");
  });

  it("no confunde el PDF417 de un DNI con el código de la licencia", async () => {
    // Alguien fotografió el DNI donde va el dorso de la licencia.
    const service = new CodeExtractionService(
      decoder({
        "license_back|original": [{ format: "PDF417", text: PDF417_DNI }],
      }),
    );

    const result = await service.extractLicenseCode([
      source("license_back", [undefined]),
    ]);

    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("BARCODE_NOT_FOUND");
  });

  it("acepta el código de la licencia cuando trae datos", async () => {
    const service = new CodeExtractionService(
      decoder({
        "license_back|original": [{ format: "QRCode", text: QR_LICENCIA }],
      }),
    );

    const result = await service.extractLicenseCode([
      source("license_back", [undefined]),
    ]);

    expect(result.data).toEqual({
      dni: "12345678",
      expiryDate: "2031-05-20",
      parsed: true,
    });
    expect(result.warnings).toEqual([]);
  });

  it("acepta un código opaco de licencia, avisando que lo es", async () => {
    const service = new CodeExtractionService(
      decoder({
        "license_back|original": [{ format: "QRCode", text: QR_OPACO }],
      }),
    );

    const result = await service.extractLicenseCode([
      source("license_back", [undefined]),
    ]);

    expect(result.data?.parsed).toBe(false);
    expect(result.payload).toBe(QR_OPACO);
    expect(result.warnings[0]?.code).toBe("LICENSE_CODE_OPAQUE");
    expect(result.warnings[0]?.message).toContain("licencias.example");
  });

  describe("readCodes (una sola foto, para el diagnóstico)", () => {
    it("devuelve el payload crudo y dice qué documento es", async () => {
      const service = new CodeExtractionService(
        decoder({
          "dni_front|original": [{ format: "PDF417", text: PDF417_DNI }],
        }),
      );

      const read = await service.readCodes(
        "dni_front",
        bytesFor("dni_front", undefined),
      );

      expect(read.codes).toHaveLength(1);
      expect(read.codes[0].kind).toBe("dni_pdf417");
      expect(read.codes[0].payload).toBe(PDF417_DNI);
      expect(read.codes[0].dni?.lastName).toBe("PEREZ");
      expect(read.error).toBeUndefined();
    });

    it("un código opaco en la licencia es el código de la licencia, no un misterio", async () => {
      const service = new CodeExtractionService(
        decoder({
          "license_back|original": [{ format: "QRCode", text: QR_OPACO }],
        }),
      );

      const read = await service.readCodes(
        "license_back",
        bytesFor("license_back", undefined),
      );

      expect(read.codes[0].kind).toBe("license_code");
      expect(read.codes[0].warnings[0]?.code).toBe("LICENSE_CODE_OPAQUE");
    });

    it("explica por qué un código de una foto del DNI no sirve", async () => {
      const service = new CodeExtractionService(
        decoder({
          "dni_front|original": [
            { format: "QRCode", text: "https://ejemplo.test/algo" },
          ],
        }),
      );

      const read = await service.readCodes(
        "dni_front",
        bytesFor("dni_front", undefined),
      );

      expect(read.codes[0].kind).toBe("unknown");
      expect(read.codes[0].errors[0]?.code).toBe("DNI_PDF417_MALFORMED");
      expect(read.codes[0].errors[0]?.hint).toContain("otro documento");
    });

    it("dice que no había código cuando la foto no trae ninguno", async () => {
      const service = new CodeExtractionService(decoder());

      const read = await service.readCodes(
        "dni_front",
        bytesFor("dni_front", undefined),
      );

      expect(read.codes).toEqual([]);
      expect(read.error?.code).toBe("BARCODE_NOT_FOUND");
      expect(read.error?.hint).toContain("ENTERO");
    });
  });
});
