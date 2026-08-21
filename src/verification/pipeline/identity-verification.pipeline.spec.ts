import {
  parseFail,
  parseOk,
  verificationError,
} from "../errors/verification-errors";
import {
  BarcodeDecoderService,
  DecodedBarcode,
  IdentityBarcodeFormat,
} from "../extraction/barcode-decoder.service";
import { CodeExtractionService } from "../extraction/code-extraction.service";
import { DocumentOcrService } from "../extraction/document-ocr.service";
import { DocumentSlot, OcrExtraction } from "../extraction/extraction.types";
import { fromOcrExtraction } from "../extraction/ocr/ocr-response.parser";
import {
  IdentityMatchService,
  IdentityProfileSnapshot,
} from "../matching/identity-match.service";
import {
  IdentityVerificationPipeline,
  SlotImages,
} from "./identity-verification.pipeline";

const PDF417 =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";
const MRZ = [
  "I<ARG12345678<8<<<<<<<<<<<<<<<",
  "9002018M3002153ARG<<<<<<<<<<<8",
  "PEREZ<<JUAN<CARLOS<<<<<<<<<<<<",
];

const PERFIL: IdentityProfileSnapshot = {
  firstName: "Juan Carlos",
  lastName: "Perez",
  dateOfBirth: new Date("1990-02-01T00:00:00.000Z"),
  dni: "12345678",
  cuil: "20123456786",
  address: "Av. Siempre Viva 742",
};

const OCR: Record<DocumentSlot, OcrExtraction> = {
  dni_front: {
    classifiedAs: "dni_front",
    fields: {
      apellido: "PEREZ",
      nombre: "JUAN CARLOS",
      nroDocumento: "12345678",
      fechaNacimiento: "01/02/1990",
      fechaVencimiento: "15/02/2030",
      sexo: "M",
    },
  },
  dni_back: {
    classifiedAs: "dni_back",
    fields: {
      domicilio: "AV SIEMPRE VIVA 742",
      cuil: "20123456786",
      mrzLines: MRZ,
    },
  },
  license_front: {
    classifiedAs: "license_front",
    fields: {
      apellido: "PEREZ",
      nroDocumento: "12345678",
      fechaVencimiento: "20/05/2031",
    },
  },
  license_back: { classifiedAs: "license_back", fields: {} },
};

const NOW = new Date("2026-08-03T12:00:00.000Z");

interface Ports {
  /** Qué código tiene cada foto. `null` = ninguno. */
  codes?: Partial<Record<DocumentSlot, string | null>>;
  ocr?: Partial<Record<DocumentSlot, OcrExtraction | null>>;
  /** El OCR de este slot nunca contesta. */
  ocrCuelga?: DocumentSlot;
}

function armar(ports: Ports = {}) {
  const barcodes = {
    decode: (bytes: Uint8Array, formats: IdentityBarcodeFormat[]) => {
      const slot = new TextDecoder()
        .decode(bytes)
        .split("|")[0] as DocumentSlot;
      const configurado = ports.codes?.[slot];
      const texto =
        configurado !== undefined
          ? configurado
          : slot === "dni_front"
            ? PDF417
            : slot === "license_back"
              ? "DNI=12345678;VTO=20/05/2031"
              : null;

      const codes: DecodedBarcode[] = texto
        ? [{ format: formats[0], text: texto }]
        : [];
      return Promise.resolve(codes);
    },
  } as unknown as BarcodeDecoderService;

  const ocr = {
    read: jest.fn((slot: DocumentSlot) => {
      if (ports.ocrCuelga === slot) return new Promise(() => undefined);

      const configurado = ports.ocr?.[slot];
      const extraction = configurado !== undefined ? configurado : OCR[slot];
      return Promise.resolve(
        extraction
          ? parseOk(fromOcrExtraction(slot, extraction))
          : parseFail(verificationError("OCR_MODEL_UNAVAILABLE", { slot })),
      );
    }),
  } as unknown as DocumentOcrService;

  const pipeline = new IdentityVerificationPipeline(
    new CodeExtractionService(barcodes),
    ocr,
    new IdentityMatchService(),
  );

  return { pipeline, ocr };
}

function imagenes(
  slots: DocumentSlot[] = [
    "dni_front",
    "dni_back",
    "license_front",
    "license_back",
  ],
): Partial<Record<DocumentSlot, SlotImages>> {
  const images: Partial<Record<DocumentSlot, SlotImages>> = {};
  for (const slot of slots) {
    images[slot] = {
      codeVariants: [undefined],
      ocrVariant: undefined,
      load: (variant) =>
        Promise.resolve({
          bytes: new TextEncoder().encode(`${slot}|${variant ?? "original"}`),
          mimeType: "image/jpeg",
        }),
    };
  }
  return images;
}

const correr = (ports: Ports = {}, slots?: DocumentSlot[]) =>
  armar(ports).pipeline.run({
    profile: PERFIL,
    images: imagenes(slots),
    now: NOW,
    ocrBudgetMs: 50,
  });

/**
 * El pipeline no decide nada: ordena el trabajo y lo mide. Lo que se prueba
 * acá es justamente eso —que cada etapa quede registrada con lo que tardó y
 * con el motivo cuando falla— y que una etapa caída no se lleve puesta a la
 * verificación entera.
 */
describe("IdentityVerificationPipeline", () => {
  it("verifica cuando códigos, texto y formulario coinciden", async () => {
    const result = await correr();

    expect(result.report.outcome).toBe("approved");
    expect(result.extraction.dniBarcode?.dni).toBe("12345678");
    expect(result.extraction.mrz?.checksumValid).toBe(true);
    expect(result.schema).toBe(2);
  });

  it("deja registrada cada etapa con lo que tardó", async () => {
    const { stages } = await correr();
    const nombres = stages.map((s) => s.stage);

    expect(nombres).toEqual(
      expect.arrayContaining([
        "codigos:dni",
        "codigos:licencia",
        "texto:dni_front",
        "texto:dni_back",
        "mrz",
        "comparacion",
      ]),
    );
    expect(stages.every((s) => typeof s.durationMs === "number")).toBe(true);
    expect(result_ok(stages)).toBe(true);
  });

  it("la matriz de comparación viaja en el reporte", async () => {
    const { report } = await correr();

    expect(report.matrix.lastName.status).toBe("agree");
    expect(report.matrix.documentNumber.resolved?.source).toBe("pdf417_dni");
  });

  describe("cuando algo falla", () => {
    it("sigue con el PDF417 y el formulario si no hay texto impreso", async () => {
      const result = await correr({
        ocr: {
          dni_front: null,
          dni_back: null,
          license_front: null,
          license_back: null,
        },
      });

      expect(result.report.outcome).toBe("approved");
      const fallidas = result.stages.filter((s) => s.status === "failed");
      expect(fallidas.map((s) => s.error?.code)).toContain(
        "OCR_MODEL_UNAVAILABLE",
      );
    });

    it("no espera para siempre al modelo: sigue sin el texto", async () => {
      // El presupuesto de esta prueba son 50 ms; el slot que cuelga no
      // contesta nunca. Sin esto, una llamada colgada se lleva puesto el
      // request entero y la persona ve un error genérico.
      const result = await correr({ ocrCuelga: "dni_back" });

      const timeout = result.stages.find((s) => s.stage === "texto");
      expect(timeout?.error?.code).toBe("STAGE_TIMEOUT");
      expect(timeout?.note).toContain("sigue con el PDF417");
      expect(result.report.outcome).toBe("approved");
    });

    it("explica que no apareció el código, con cuántos intentos", async () => {
      const result = await correr({
        codes: { dni_front: null, dni_back: null },
        ocr: { dni_back: { classifiedAs: "dni_back", fields: {} } },
      });

      expect(result.dniCode.error?.code).toBe("BARCODE_NOT_FOUND");
      expect(result.dniCode.attempts).toHaveLength(2);
      expect(result.report.reasonCodes).toContain("NO_AUTHORITATIVE_SOURCE");
    });

    it("saltea la foto que no se recibió, sin darla por fallada", async () => {
      const result = await correr({}, ["dni_front", "dni_back"]);

      const licencia = result.stages.find(
        (s) => s.stage === "texto:license_front",
      );
      expect(licencia?.status).toBe("skipped");
      expect(licencia?.note).toContain("no se recibió");
    });

    it("dice qué dígito del MRZ no cerró", async () => {
      const roto = [
        `${MRZ[0].slice(0, 14)}0${MRZ[0].slice(15)}`,
        MRZ[1],
        MRZ[2],
      ];
      const result = await correr({
        ocr: {
          dni_back: {
            classifiedAs: "dni_back",
            fields: { ...OCR.dni_back.fields, mrzLines: roto },
          },
        },
      });

      const mrz = result.stages.find((s) => s.stage === "mrz");
      expect(mrz?.note).toContain("número de documento");
      expect(result.extraction.mrz?.checksumValid).toBe(false);
    });
  });

  describe("runSingle (una foto sola, para el diagnóstico)", () => {
    it("devuelve el código y el texto de esa foto", async () => {
      const { pipeline } = armar();

      const result = await pipeline.runSingle(
        "dni_front",
        new TextEncoder().encode("dni_front|original"),
      );

      expect(result.codes.codes[0].kind).toBe("dni_pdf417");
      expect(result.codes.codes[0].payload).toBe(PDF417);
      expect(result.ocr?.fields.lastName?.value).toBe("PEREZ");
      expect(result.stages.map((s) => s.stage)).toEqual(
        expect.arrayContaining(["codigos:dni_front", "texto:dni_front"]),
      );
    });

    it("parsea el MRZ cuando la foto es el dorso del DNI", async () => {
      const { pipeline } = armar();

      const result = await pipeline.runSingle(
        "dni_back",
        new TextEncoder().encode("dni_back|original"),
      );

      expect(result.mrz?.data?.documentNumber).toBe("12345678");
      expect(result.mrz?.data?.checksumValid).toBe(true);
    });

    it("informa el motivo cuando el modelo no pudo leer la foto", async () => {
      const { pipeline } = armar({ ocr: { license_front: null } });

      const result = await pipeline.runSingle(
        "license_front",
        new TextEncoder().encode("license_front|original"),
      );

      expect(result.ocr).toBeNull();
      expect(result.ocrError?.code).toBe("OCR_MODEL_UNAVAILABLE");
      expect(result.ocrError?.hint).toBeTruthy();
    });
  });
});

/** Ninguna etapa quedó sin estado. */
function result_ok(stages: { status: string }[]): boolean {
  return stages.every((s) => ["ok", "skipped", "failed"].includes(s.status));
}
