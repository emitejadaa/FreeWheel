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

    expect(verdict.approved).toBe(true);
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

    expect(verdict.approved).toBe(false);
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
  });

  it("leaves the submission pending — never approved — when the AI is unavailable", async () => {
    const unavailable: DocumentInspection = {
      matches: null,
      reason: "La revisión automática no está disponible.",
    };
    const reviewer = new AiIdentityReviewer(
      makeAi([unavailable, unavailable, unavailable, unavailable]),
    );

    const verdict = await reviewer.review(input);

    // Antes esto aprobaba "para no dejar cuentas sin verificar", y así una foto
    // de un perro quedó aprobada como DNI el día que el modelo de Groq se cayó.
    // Ahora espera a un admin: pendiente no es lo mismo que rechazado.
    expect(verdict.approved).toBe(false);
    expect(verdict.pending).toBe(true);
    expect(verdict.notes).toContain("no está disponible");
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

    expect(verdict.approved).toBe(false);
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

    expect(verdict.approved).toBe(true);
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

    expect(verdict.approved).toBe(false);
    expect(verdict.notes).toContain("no coincide con el del");
  });

  it("rejects an expired licence", async () => {
    const reviewer = new AiIdentityReviewer(
      makeAi([good(), good(), good(), good({ expiresAt: "2020-01-31" })]),
    );

    const verdict = await reviewer.review(input);

    expect(verdict.approved).toBe(false);
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

    expect(verdict.approved).toBe(true);
  });
});
