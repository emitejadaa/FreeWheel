import { CloudinaryService } from "../../media/cloudinary.service";
import { BarcodeDecoderService } from "../extraction/barcode-decoder.service";
import { DocumentOcrService } from "../extraction/document-ocr.service";
import { DocumentSlot, OcrExtraction } from "../extraction/extraction.types";
import { IdentityDocumentsService } from "../identity/identity-documents.service";
import { IdentityMatchService } from "../matching/identity-match.service";
import { DocumentAiReviewer } from "./document-ai.reviewer";
import { IdentityReviewInput } from "./identity-reviewer.interface";

const USER = "user-1";
const CLOUD = "test-cloud";

const PDF417 =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";
const MRZ = [
  "I<ARG12345678<8<<<<<<<<<<<<<<<",
  "9002018M3002153ARG<<<<<<<<<<<8",
  "PEREZ<<JUAN<CARLOS<<<<<<<<<<<<",
];

function url(slot: DocumentSlot): string {
  return `https://res.cloudinary.com/${CLOUD}/image/authenticated/identity/${USER}/${slot}_1_aaaa.jpg`;
}

const INPUT: IdentityReviewInput = {
  userId: USER,
  verificationId: "ver-1",
  dniFrontUrl: url("dni_front"),
  dniBackUrl: url("dni_back"),
  licenseFrontUrl: url("license_front"),
  licenseBackUrl: url("license_back"),
  profile: {
    firstName: "Juan Carlos",
    lastName: "Pérez",
    dateOfBirth: new Date("1990-02-01T00:00:00.000Z"),
    dni: "12345678",
    cuil: "20123456786",
    address: "Av. Siempre Viva 742",
  },
};

const OCR_BY_SLOT: Record<DocumentSlot, OcrExtraction> = {
  dni_front: {
    classifiedAs: "dni_front",
    fields: {
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

interface Ports {
  barcodesBySlot?: Partial<Record<DocumentSlot, string | null>>;
  ocrBySlot?: Partial<Record<DocumentSlot, OcrExtraction | null>>;
  downloadFails?: boolean;
}

function makeReviewer(ports: Ports = {}) {
  const cloudinary = {
    getCloudName: () => CLOUD,
    download: jest.fn((publicId: string) => {
      if (ports.downloadFails) throw new Error("almacenamiento caído");
      return Promise.resolve({
        // Los bytes identifican el slot para que los fakes respondan por slot.
        bytes: new TextEncoder().encode(publicId),
        mimeType: "image/jpeg",
      });
    }),
  } as unknown as CloudinaryService;

  const documents = new IdentityDocumentsService(cloudinary);

  const slotOf = (bytes: Uint8Array): DocumentSlot => {
    const publicId = new TextDecoder().decode(bytes);
    const slots: DocumentSlot[] = [
      "dni_front",
      "dni_back",
      "license_front",
      "license_back",
    ];
    return slots.find((slot) => publicId.includes(`/${slot}_`)) ?? "dni_front";
  };

  const barcodes = {
    decode: jest.fn((bytes: Uint8Array) => {
      const slot = slotOf(bytes);
      const configured = ports.barcodesBySlot?.[slot];
      const text =
        configured !== undefined
          ? configured
          : slot === "dni_front"
            ? PDF417
            : slot === "license_back"
              ? "DNI=12345678;VTO=20/05/2031"
              : null;
      return Promise.resolve(text ? [{ format: "PDF417" as const, text }] : []);
    }),
  } as unknown as BarcodeDecoderService;

  const ocr = {
    extract: jest.fn((slot: DocumentSlot) => {
      const configured = ports.ocrBySlot?.[slot];
      return Promise.resolve(
        configured !== undefined ? configured : OCR_BY_SLOT[slot],
      );
    }),
  } as unknown as DocumentOcrService;

  const reviewer = new DocumentAiReviewer(
    cloudinary,
    documents,
    barcodes,
    ocr,
    new IdentityMatchService(),
  );

  return { reviewer, cloudinary, barcodes, ocr };
}

describe("DocumentAiReviewer", () => {
  it("aprueba cuando códigos, OCR y cuenta coinciden", async () => {
    const { reviewer } = makeReviewer();
    const verdict = await reviewer.review(INPUT);

    expect(verdict.outcome).toBe("approved");
    expect(verdict.reasonCodes).toEqual([]);
    expect(verdict.documentNumber).toBe("12345678");
    expect(verdict.licenseExpiresAt).toEqual(
      new Date("2031-05-20T00:00:00.000Z"),
    );
    expect(verdict.matchReport).toBeDefined();
    expect(verdict.extracted).toBeDefined();
  });

  it("rechaza cuando la cuenta declara otra fecha de nacimiento", async () => {
    const { reviewer } = makeReviewer();
    const verdict = await reviewer.review({
      ...INPUT,
      profile: {
        ...INPUT.profile,
        dateOfBirth: new Date("1995-05-05T00:00:00.000Z"),
      },
    });

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("DOB_MISMATCH");
    expect(verdict.notes).toContain("Rechazo automático");
  });

  it("cae a revisión manual si no se puede leer el PDF417 ni el MRZ", async () => {
    const { reviewer } = makeReviewer({
      barcodesBySlot: { dni_front: null },
      ocrBySlot: {
        dni_back: {
          classifiedAs: "dni_back",
          fields: { domicilio: "AV SIEMPRE VIVA 742", cuil: "20123456786" },
        },
      },
    });

    const verdict = await reviewer.review(INPUT);
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reasonCodes).toContain("NO_AUTHORITATIVE_SOURCE");
  });

  it("usa el MRZ como ancla si el PDF417 no se pudo decodificar", async () => {
    const { reviewer } = makeReviewer({ barcodesBySlot: { dni_front: null } });
    const verdict = await reviewer.review(INPUT);
    expect(verdict.outcome).toBe("approved");
    expect(verdict.documentNumber).toBe("12345678");
  });

  /**
   * El PDF417 del RENAPER no está siempre del mismo lado: según el ejemplar se
   * imprime en el frente o en el dorso. Buscarlo solo en el frente dejaba sin
   * ancla —y por lo tanto en revisión manual— a todo un tipo de documento, aun
   * teniendo la foto con el código bien a la vista.
   */
  it("encuentra el PDF417 aunque esté impreso en el dorso del DNI", async () => {
    const { reviewer } = makeReviewer({
      barcodesBySlot: { dni_front: null, dni_back: PDF417 },
      // Sin MRZ, para que la única ancla posible sea el código del dorso.
      ocrBySlot: {
        dni_back: {
          classifiedAs: "dni_back",
          fields: { domicilio: "AV SIEMPRE VIVA 742", cuil: "20123456786" },
        },
      },
    });

    const verdict = await reviewer.review(INPUT);

    expect(verdict.outcome).toBe("approved");
    expect(verdict.documentNumber).toBe("12345678");
  });

  /**
   * El OCR es la única parte que escribe un modelo, y es la que se cae: sin
   * clave, sin cuota o con el modelo dado de baja, extract() devuelve null en
   * los cuatro slots. La verificación tiene que seguir decidiendo con el
   * PDF417 y lo que la persona cargó en el formulario.
   */
  it("aprueba con el PDF417 y el formulario aunque el OCR no lea nada", async () => {
    const { reviewer, ocr } = makeReviewer({
      ocrBySlot: {
        dni_front: null,
        dni_back: null,
        license_front: null,
        license_back: null,
      },
    });

    const verdict = await reviewer.review(INPUT);

    // El OCR se intentó igual: lo que cambia es que su silencio no bloquea.
    expect((ocr.extract as jest.Mock).mock.calls).toHaveLength(4);
    expect(verdict.outcome).toBe("approved");
    expect(verdict.documentNumber).toBe("12345678");
  });

  it("sin OCR sigue rechazando lo que el PDF417 contradice", async () => {
    const { reviewer } = makeReviewer({
      ocrBySlot: {
        dni_front: null,
        dni_back: null,
        license_front: null,
        license_back: null,
      },
    });

    const verdict = await reviewer.review({
      ...INPUT,
      profile: { ...INPUT.profile, lastName: "Gómez" },
    });

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("SURNAME_MISMATCH");
  });

  it("rechaza una foto subida en el slot equivocado", async () => {
    const { reviewer } = makeReviewer({
      ocrBySlot: {
        license_front: { classifiedAs: "dni_back", fields: {} },
      },
    });

    const verdict = await reviewer.review(INPUT);
    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("SLOT_CONTENT_MISMATCH");
  });

  it("reintenta el decodificado con variantes de la imagen", async () => {
    const { reviewer, cloudinary } = makeReviewer({
      barcodesBySlot: { dni_front: null },
    });
    await reviewer.review(INPUT);

    const transformations = (cloudinary.download as jest.Mock).mock.calls
      .filter(([publicId]) => (publicId as string).includes("/dni_front_"))
      .map(
        ([, options]) =>
          (options as { transformation?: string }).transformation,
      );
    // Tres variantes probadas para el frente del DNI + la del OCR.
    expect(transformations).toContain("c_limit,w_2000,q_auto:best");
    expect(transformations).toContain(undefined);
    expect(transformations.length).toBeGreaterThanOrEqual(3);
  });

  it("no explota si el almacenamiento falla: queda inconcluso", async () => {
    const { reviewer } = makeReviewer({ downloadFails: true });
    const verdict = await reviewer.review(INPUT);
    expect(verdict.outcome).toBe("inconclusive");
  });

  it("nunca pone datos personales en reasonCodes ni en notes", async () => {
    const { reviewer } = makeReviewer();
    const verdict = await reviewer.review({
      ...INPUT,
      profile: { ...INPUT.profile, lastName: "Gómez" },
    });

    expect(verdict.outcome).toBe("rejected");
    const surface = JSON.stringify({
      reasonCodes: verdict.reasonCodes,
      notes: verdict.notes,
    });
    expect(surface).not.toContain("Gómez");
    expect(surface).not.toContain("PEREZ");
    expect(surface).not.toContain("12345678");
  });
});
