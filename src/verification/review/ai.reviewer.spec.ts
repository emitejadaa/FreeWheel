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

  it("does not block the account when the AI service is unavailable", async () => {
    const unavailable: DocumentInspection = {
      matches: null,
      reason: "La revisión automática no está disponible.",
    };
    const reviewer = new AiIdentityReviewer(
      makeAi([unavailable, unavailable, unavailable, unavailable]),
    );

    const verdict = await reviewer.review(input);

    // Que falte un servicio externo no puede dejar a todas las cuentas sin
    // verificar: se aprueba y queda anotado que no se revisó.
    expect(verdict.approved).toBe(true);
    expect(verdict.notes).toContain("no disponible");
  });
});
