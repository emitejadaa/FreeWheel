import { AiService } from "../../ai/ai.service";
import { DocumentOcrService, parseOcrJson } from "./document-ocr.service";

const BYTES = new Uint8Array([1, 2, 3]);

function makeService(response: string | null) {
  const visionStructured = jest.fn().mockResolvedValue(response);
  const ai = { visionStructured } as unknown as AiService;
  return { service: new DocumentOcrService(ai), visionStructured };
}

describe("parseOcrJson", () => {
  it("lee un JSON limpio", () => {
    expect(
      parseOcrJson(
        '{"classifiedAs":"dni_front","fields":{"apellido":"PEREZ"}}',
      ),
    ).toEqual({ classifiedAs: "dni_front", fields: { apellido: "PEREZ" } });
  });

  it("tolera ``` y texto alrededor", () => {
    const raw =
      'Claro, acá tenés:\n```json\n{"classifiedAs":"dni_back","fields":{"cuil":"20123456786"}}\n```';
    expect(parseOcrJson(raw)).toEqual({
      classifiedAs: "dni_back",
      fields: { cuil: "20123456786" },
    });
  });

  it("descarta campos desconocidos y vacíos", () => {
    const parsed = parseOcrJson(
      '{"classifiedAs":"dni_front","fields":{"apellido":"  ","inventado":"x","nroDocumento":12345678}}',
    );
    expect(parsed?.fields).toEqual({ nroDocumento: "12345678" });
  });

  it("normaliza una clasificación desconocida a unknown", () => {
    expect(parseOcrJson('{"classifiedAs":"pasaporte","fields":{}}')).toEqual({
      classifiedAs: "unknown",
      fields: {},
    });
    expect(parseOcrJson('{"fields":{}}')?.classifiedAs).toBe("unknown");
  });

  it("conserva las líneas del MRZ tal cual", () => {
    const parsed = parseOcrJson(
      '{"classifiedAs":"dni_back","fields":{"mrzLines":["I<ARG12345678<8<<<<<<<<<<<<<<<","x",123]}}',
    );
    expect(parsed?.fields.mrzLines).toEqual([
      "I<ARG12345678<8<<<<<<<<<<<<<<<",
      "x",
    ]);
  });

  it("devuelve null ante texto que no trae JSON", () => {
    expect(parseOcrJson("no puedo leer la imagen")).toBeNull();
    expect(parseOcrJson("{roto")).toBeNull();
    expect(parseOcrJson("")).toBeNull();
  });
});

describe("DocumentOcrService.extract", () => {
  it("pide la lectura del slot correspondiente y devuelve lo parseado", async () => {
    const { service, visionStructured } = makeService(
      '{"classifiedAs":"license_front","fields":{"nroDocumento":"12345678"}}',
    );

    const result = await service.extract("license_front", BYTES);

    expect(result).toEqual({
      classifiedAs: "license_front",
      fields: { nroDocumento: "12345678" },
    });
    const [dataUrl, prompt] = visionStructured.mock.calls[0] as [
      string,
      string,
    ];
    // La imagen viaja como data URL: el proveedor nunca recibe una URL del
    // documento almacenado.
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(prompt).toContain("licencia de conducir");
  });

  it("devuelve null si el proveedor falla", async () => {
    const { service } = makeService(null);
    expect(await service.extract("dni_front", BYTES)).toBeNull();
  });

  it("devuelve null si la respuesta no es parseable", async () => {
    const { service } = makeService("no pude leer nada");
    expect(await service.extract("dni_front", BYTES)).toBeNull();
  });

  it("no llama al proveedor si la imagen está vacía", async () => {
    const { service, visionStructured } = makeService("{}");
    expect(await service.extract("dni_front", new Uint8Array())).toBeNull();
    expect(visionStructured).not.toHaveBeenCalled();
  });
});
