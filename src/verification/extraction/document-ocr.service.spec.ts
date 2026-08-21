import { AiService, VisionAnswer, VisionFailure } from "../../ai/ai.service";
import { DocumentOcrService } from "./document-ocr.service";

const BYTES = new Uint8Array([1, 2, 3]);

const RESPUESTA = JSON.stringify({
  documento: "dni_frente",
  campos: {
    apellido: { valor: "PEREZ" },
    nombres: { valor: "JUAN CARLOS" },
    nro_documento: { valor: "12.345.678" },
  },
  texto_completo: "REPUBLICA ARGENTINA",
});

function contesta(answer: VisionAnswer | VisionFailure): {
  service: DocumentOcrService;
  visionStructuredDetailed: jest.Mock;
} {
  const visionStructuredDetailed = jest.fn().mockResolvedValue(answer);
  const ai = { visionStructuredDetailed } as unknown as AiService;
  return {
    service: new DocumentOcrService(ai),
    visionStructuredDetailed,
  };
}

const ok = (content: string): VisionAnswer => ({
  ok: true,
  content,
  model: "modelo-x",
  durationMs: 120,
});

const falla = (
  code: VisionFailure["code"],
  extra: Partial<VisionFailure> = {},
): VisionFailure => ({
  ok: false,
  code,
  model: "modelo-x",
  sample: null,
  durationMs: 90,
  triedModels: ["modelo-x", "modelo-y"],
  ...extra,
});

/**
 * Lo que se prueba acá es el contrato con el modelo: qué se le pide, y qué
 * pasa con cada forma de que no conteste. La interpretación de la respuesta
 * vive en ocr-response.parser.spec.ts, que es puro y no necesita fakes.
 */
describe("DocumentOcrService.read", () => {
  it("le prohíbe al modelo comparar o validar: solo leer", async () => {
    const { service, visionStructuredDetailed } = contesta(ok(RESPUESTA));

    await service.read("dni_front", BYTES);

    const [, prompt] = visionStructuredDetailed.mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(prompt).toContain("TU ÚNICA TAREA ES LEER");
    expect(prompt).toContain("NO compares con nada");
    expect(prompt).toContain("NO valides");
  });

  it("le manda la imagen, no una URL: nadie más ve el documento", async () => {
    const { service, visionStructuredDetailed } = contesta(ok(RESPUESTA));

    await service.read("dni_front", BYTES, "image/png");

    const [imagen] = visionStructuredDetailed.mock.calls[0] as [string];
    expect(imagen.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("le da más lugar a la respuesta del dorso del DNI, que es la más larga", async () => {
    const { service, visionStructuredDetailed } = contesta(ok(RESPUESTA));

    await service.read("dni_front", BYTES);
    await service.read("dni_back", BYTES);

    const [frente, dorso] = visionStructuredDetailed.mock.calls.map(
      (call) => (call as [string, string, number])[2],
    );
    expect(dorso).toBeGreaterThan(frente);
  });

  it("pide las posiciones solo cuando se las piden", async () => {
    const { service, visionStructuredDetailed } = contesta(ok(RESPUESTA));

    await service.read("dni_front", BYTES, "image/jpeg", { withBoxes: true });

    const [, prompt, tokens] = visionStructuredDetailed.mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(prompt).toContain('"caja"');
    // Pedir posiciones alarga la respuesta: hay que darle lugar o llega cortada.
    expect(tokens).toBeGreaterThan(1400);
  });

  it("devuelve la lectura con el modelo que contestó", async () => {
    const { service } = contesta(ok(RESPUESTA));

    const result = await service.read("dni_front", BYTES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fields.lastName?.value).toBe("PEREZ");
    expect(result.data.model).toBe("modelo-x");
  });

  it("no llama al modelo con una imagen vacía", async () => {
    const { service, visionStructuredDetailed } = contesta(ok(RESPUESTA));

    const result = await service.read("dni_front", new Uint8Array());

    expect(visionStructuredDetailed).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IMAGE_EMPTY");
  });

  describe("cuando el modelo no contesta", () => {
    it("distingue que falte la clave en el servidor", async () => {
      const { service } = contesta(falla("not_configured"));

      const result = await service.read("dni_front", BYTES);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_NOT_CONFIGURED");
      expect(result.error.message).toContain("GROQ_API_KEY");
    });

    it("distingue que el proveedor haya fallado, y dice cuántos se probaron", async () => {
      const { service } = contesta(falla("upstream_error"));

      const result = await service.read("dni_front", BYTES);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_MODEL_UNAVAILABLE");
      expect(result.error.message).toContain("2 modelos");
      expect(result.error.detail).toContain("modelo-y");
    });

    it("distingue que haya contestado cualquier cosa, y muestra qué", async () => {
      const { service } = contesta(
        falla("unreadable", { sample: "No puedo ayudarte con documentos." }),
      );

      const result = await service.read("dni_front", BYTES);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_RESPONSE_NOT_JSON");
      expect(result.error.message).toContain("No puedo ayudarte");
    });
  });
});

describe("DocumentOcrService.extract", () => {
  it("proyecta la lectura al formato plano que consume el cruce", async () => {
    const { service } = contesta(ok(RESPUESTA));

    expect(await service.extract("dni_front", BYTES)).toEqual(
      expect.objectContaining({
        classifiedAs: "dni_front",
        fields: {
          apellido: "PEREZ",
          nombre: "JUAN CARLOS",
          nroDocumento: "12.345.678",
        },
      }),
    );
  });

  it("devuelve null sin lanzar cuando no se pudo leer", async () => {
    const { service } = contesta(falla("upstream_error"));
    expect(await service.extract("dni_front", BYTES)).toBeNull();
  });
});
