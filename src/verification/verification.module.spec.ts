import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai/ai.service";
import { resolveIdentityReviewer } from "./verification.module";
import { DocumentAiReviewer } from "./review/document-ai.reviewer";

const documentAi = { name: "document_ai" } as unknown as DocumentAiReviewer;
const ai = {} as unknown as AiService;

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const FULL_CREDENTIALS = {
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "key",
  CLOUDINARY_API_SECRET: "secret",
  GROQ_API_KEY: "groq",
};

const resolve = (env: Record<string, string>) =>
  resolveIdentityReviewer(configWith(env), documentAi, ai);

describe("resolveIdentityReviewer", () => {
  it("usa la revisión documental completa por defecto", () => {
    expect(resolve(FULL_CREDENTIALS)).toBe(documentAi);
  });

  it("acepta manual", () => {
    expect(resolve({ IDENTITY_REVIEW_MODE: "manual" }).name).toBe("manual");
  });

  it("acepta auto_approve", () => {
    expect(resolve({ IDENTITY_REVIEW_MODE: "auto_approve" }).name).toBe(
      "auto_approve",
    );
  });

  it("acepta la revisión liviana por visión", () => {
    expect(resolve({ IDENTITY_REVIEW_MODE: "ai" }).name).toBe("ai");
  });

  it("acepta document_ai explícito cuando están todas las credenciales", () => {
    expect(
      resolve({ IDENTITY_REVIEW_MODE: "document_ai", ...FULL_CREDENTIALS }),
    ).toBe(documentAi);
  });

  it("es insensible a mayúsculas en el modo", () => {
    expect(
      resolve({ IDENTITY_REVIEW_MODE: "Document_AI", ...FULL_CREDENTIALS }),
    ).toBe(documentAi);
  });

  // Pedir a mano una revisión que no se puede hacer es un error de
  // configuración: mejor no arrancar que aparentar que se revisa.
  it.each([
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ])("no arranca con document_ai explícito si falta %s", (missingKey) => {
    const env: Record<string, string> = {
      IDENTITY_REVIEW_MODE: "document_ai",
      ...FULL_CREDENTIALS,
    };
    delete env[missingKey];

    expect(() => resolve(env)).toThrow(new RegExp(missingKey));
  });

  // En cambio, si document_ai es solo el default, faltar credenciales no puede
  // tumbar la app: se cae a manual, que es el lado seguro (nadie se verifica
  // solo, decide un admin).
  it("cae a manual si faltan credenciales y el modo es solo el default", () => {
    expect(resolve({}).name).toBe("manual");
    expect(resolve({ GROQ_API_KEY: "groq" }).name).toBe("manual");
  });

  /**
   * GROQ_API_KEY ya no es un requisito: la clave la usa el OCR, que corrobora,
   * no el PDF417, que es el ancla. Cuando era obligatoria, cualquier problema
   * con Groq —clave sin cuota, modelo dado de baja— apagaba la revisión
   * automática entera y mandaba a la cola del admin verificaciones que el
   * código de barras del DNI podía resolver solo.
   */
  it("revisa igual sin GROQ_API_KEY: el OCR es opcional", () => {
    const sinGroq = {
      CLOUDINARY_CLOUD_NAME: "demo",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
    };

    expect(resolve(sinGroq)).toBe(documentAi);
    expect(resolve({ IDENTITY_REVIEW_MODE: "document_ai", ...sinGroq })).toBe(
      documentAi,
    );
  });

  it("no arranca con un modo desconocido", () => {
    expect(() => resolve({ IDENTITY_REVIEW_MODE: "lo-que-sea" })).toThrow(
      /Unknown IDENTITY_REVIEW_MODE/,
    );
  });
});
