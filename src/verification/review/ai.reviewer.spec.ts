import { AiService } from "../../ai/ai.service";
import type { DocumentInspection } from "../../ai/ai.service";
import { AiIdentityReviewer } from "./ai.reviewer";
import { IdentityReviewInput } from "./identity-reviewer.interface";

const input: IdentityReviewInput = {
  userId: "user-1",
  verificationId: "ver-1",
  dniFrontUrl: "https://cdn.test/dni-front.jpg",
  dniBackUrl: "https://cdn.test/dni-back.jpg",
  licenseFrontUrl: "https://cdn.test/lic-front.jpg",
  licenseBackUrl: "https://cdn.test/lic-back.jpg",
  profile: {
    firstName: "Ignacio",
    lastName: "Britos",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    dni: "40123456",
    cuil: "20401234563",
    address: "Av. Siempre Viva 742",
  },
};

/** AiService que responde lo que le indique el test para cada foto. */
function makeAi(responses: DocumentInspection[]): AiService {
  let call = 0;
  return {
    inspectDocument: jest.fn(() =>
      Promise.resolve(responses[call++] ?? responses[0]),
    ),
  } as unknown as AiService;
}

const good = (extra: Partial<DocumentInspection> = {}): DocumentInspection => ({
  matches: true,
  reason: "Coincide",
  ...extra,
});

describe("AiIdentityReviewer", () => {
  it("approves when every photo matches the expected document", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([good(), good(), good(), good()]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("approved");
    expect(verdict.reasonCodes).toEqual([]);
  });

  it("rejects when a photo is not the requested document", async () => {
    // La segunda foto no es un DNI: no se puede subir cualquier imagen.
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good(),
        { matches: false, reason: "Es la foto de un paisaje" },
        good(),
        good(),
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("AI_DOCUMENT_MISMATCH");
    expect(verdict.notes).toContain("paisaje");
    expect(verdict.notes).toContain("dorso del DNI");
  });

  it("extracts the document data so it is stored instead of typed by the user", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good({ documentNumber: "40123456", fullName: "Ignacio Britos" }),
        good(),
        good(),
        good({ expiresAt: "2030-05-20" }),
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.extracted).toEqual({
      documentNumber: "40123456",
      fullName: "Ignacio Britos",
      licenseExpiresAt: "2030-05-20",
    });
    // Y se promueven a columnas para poder consultarlos y cruzarlos.
    expect(verdict.documentNumber).toBe("40123456");
    expect(verdict.fullNameOnDocument).toBe("Ignacio Britos");
    expect(verdict.licenseExpiresAt).toEqual(
      new Date("2030-05-20T00:00:00.000Z"),
    );
  });

  it("sends the case to manual review when the AI service is unavailable", async () => {
    const unavailable: DocumentInspection = {
      matches: null,
      reason: "La revisión automática no está disponible.",
    };
    const reviewer = new AiIdentityReviewer(
      makeAi([unavailable, unavailable, unavailable, unavailable]),
    );

    const verdict = await reviewer.review(input);

    // Que falte el servicio externo no rechaza a la persona, pero tampoco la
    // aprueba: si nadie miró las fotos, cualquier imagen entraría. El caso
    // queda ID_SUBMITTED esperando a un admin.
    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reasonCodes).toContain("AI_UNAVAILABLE");
    expect(verdict.notes).toContain("revisión manual");
  });

  it("sends the case to manual review when only some photos could be checked", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good(),
        good(),
        good(),
        { matches: null, reason: "No se pudo interpretar la revisión." },
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("inconclusive");
    expect(verdict.reasonCodes).toContain("AI_PARTIALLY_UNAVAILABLE");
  });

  it("rejects a licence issued to somebody other than the DNI holder", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good({ documentNumber: "40123456", fullName: "Ignacio Britos" }),
        good(),
        good({ documentNumber: "38999111", fullName: "Carmen Vega" }),
        good({ expiresAt: "2030-05-20" }),
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("LICENSE_NAME_MISMATCH");
    expect(verdict.notes).toContain("no coincide con el del DNI");
  });

  it("accepts the same person even when one document adds a middle name", async () => {
    // El DNI dice "PÉREZ, Juan Carlos" y la licencia "JUAN PEREZ": misma persona.
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good({ documentNumber: "40123456", fullName: "PÉREZ, Juan Carlos" }),
        good(),
        good({ documentNumber: "40123456", fullName: "JUAN PEREZ" }),
        good({ expiresAt: "2030-05-20" }),
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("approved");
  });

  it("rejects a licence whose number is not the DNI number", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([
        good({ documentNumber: "40123456" }),
        good(),
        good({ documentNumber: "11222333" }),
        good(),
      ]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("LICENSE_DNI_MISMATCH");
    expect(verdict.notes).toContain("no coincide con el del");
  });

  it("rejects an expired licence", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([good(), good(), good(), good({ expiresAt: "2020-01-31" })]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("rejected");
    expect(verdict.reasonCodes).toContain("LICENSE_EXPIRED");
    expect(verdict.notes).toContain("vencida");
  });

  it("does not invent a rejection when a name could not be read", async () => {
    // Las cuatro fotos son los documentos pedidos, pero la IA no pudo leer el
    // nombre de la licencia. Rechazar por un dato ilegible dejaría afuera a
    // gente con documentos válidos.
    const reviewer = new AiIdentityReviewer(
      makeAi([good({ fullName: "Ignacio Britos" }), good(), good(), good()]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.outcome).toBe("approved");
  });
});
