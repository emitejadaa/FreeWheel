import { ConfigService } from "@nestjs/config";
import { resolveIdentityReviewer } from "./verification.module";
import { DocumentAiReviewer } from "./review/document-ai.reviewer";

const documentAi = { name: "document_ai" } as unknown as DocumentAiReviewer;

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const FULL_CREDENTIALS = {
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "secret",
  GROQ_API_KEY: "groq",
};

describe("resolveIdentityReviewer", () => {
  it("usa auto_approve por defecto", () => {
    expect(resolveIdentityReviewer(configWith({}), documentAi).name).toBe(
      "auto_approve",
    );
  });

  it("acepta manual", () => {
    const reviewer = resolveIdentityReviewer(
      configWith({ IDENTITY_REVIEW_MODE: "manual" }),
      documentAi,
    );
    expect(reviewer.name).toBe("manual");
  });

  it("acepta document_ai cuando estan todas las credenciales", () => {
    const reviewer = resolveIdentityReviewer(
      configWith({
        IDENTITY_REVIEW_MODE: "document_ai",
        ...FULL_CREDENTIALS,
      }),
      documentAi,
    );
    expect(reviewer).toBe(documentAi);
  });

  it("es insensible a mayusculas en el modo", () => {
    expect(
      resolveIdentityReviewer(
        configWith({
          IDENTITY_REVIEW_MODE: "Document_AI",
          ...FULL_CREDENTIALS,
        }),
        documentAi,
      ),
    ).toBe(documentAi);
  });

  // Fallar al arrancar es deliberado: peor que no arrancar seria arrancar
  // aparentando revisar documentos y no poder hacerlo.
  it.each([
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "GROQ_API_KEY",
  ])("no arranca en document_ai si falta %s", (missingKey) => {
    const env: Record<string, string> = {
      IDENTITY_REVIEW_MODE: "document_ai",
      ...FULL_CREDENTIALS,
    };
    delete env[missingKey];

    expect(() => resolveIdentityReviewer(configWith(env), documentAi)).toThrow(
      new RegExp(missingKey),
    );
  });

  it("no arranca con un modo desconocido", () => {
    expect(() =>
      resolveIdentityReviewer(
        configWith({ IDENTITY_REVIEW_MODE: "lo-que-sea" }),
        documentAi,
      ),
    ).toThrow(/Unknown IDENTITY_REVIEW_MODE/);
  });
});
