import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { PythonDocverifyService } from "./python-docverify.service";

/**
 * EL TRANSPORTE HTTP CONTRA UN SERVIDOR DE VERDAD
 *
 * Es el camino que usa el deploy: en serverless no hay Python, así que las
 * fotos viajan a un verificador que corre en otro lado. Se levanta un servidor
 * HTTP real (no un mock de fetch) porque lo que hay que comprobar es
 * justamente el cable: que las fotos lleguen en base64, que el token viaje, y
 * que un remoto caído o lento no se traduzca en un 500 sin explicación.
 */
describe("PythonDocverifyService con verificador remoto", () => {
  let server: Server;
  let url: string;
  let recibido: { headers: Record<string, unknown>; body: string } | null;
  let responder: (body: string) => { status: number; body: string };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let cuerpo = "";
      req.on("data", (c: Buffer) => (cuerpo += c.toString("utf8")));
      req.on("end", () => {
        recibido = { headers: req.headers, body: cuerpo };
        const respuesta = responder(cuerpo);
        res.writeHead(respuesta.status, { "content-type": "application/json" });
        res.end(respuesta.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    recibido = null;
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        version: "1.0",
        documentos: {
          dni_front: { ocr: { title: "ocr", nDocumento: "30111222" } },
        },
      }),
    });
  });

  /** El servicio apuntando al servidor de prueba. */
  function servicio(overrides: Record<string, string> = {}) {
    const env: Record<string, string> = {
      DOCVERIFY_URL: url,
      DOCVERIFY_TOKEN: "clave-compartida",
      ...overrides,
    };
    return new PythonDocverifyService({
      get: (key: string) => env[key],
    } as unknown as ConfigService);
  }

  const foto = () => new Uint8Array([1, 2, 3, 4]);

  it("manda las fotos en base64 y devuelve el contrato tal cual", async () => {
    const res = await servicio().analyze({ dni_front: foto() });

    expect(res.ok).toBe(true);
    expect(res.documentos?.dni_front).toBeTruthy();

    // Las fotos viajan en el cuerpo porque el remoto no comparte disco con
    // este proceso: no puede abrir una ruta nuestra.
    const enviado = JSON.parse(recibido!.body) as {
      documentos: Record<string, string>;
    };
    expect(enviado.documentos.dni_front).toBe(
      Buffer.from(foto()).toString("base64"),
    );
  });

  it("manda el token, porque del otro lado hay documentos de identidad", async () => {
    await servicio().analyze({ dni_front: foto() });
    expect(recibido!.headers.authorization).toBe("Bearer clave-compartida");
  });

  it("sin token configurado no manda el header", async () => {
    await servicio({ DOCVERIFY_TOKEN: "" }).analyze({ dni_front: foto() });
    expect(recibido!.headers.authorization).toBeUndefined();
  });

  it("tolera la barra final en la URL", async () => {
    await servicio({ DOCVERIFY_URL: `${url}/` }).analyze({ dni_front: foto() });
    expect(recibido).not.toBeNull();
  });

  it("un 401 del remoto sale como 503 diciendo qué contestó", async () => {
    responder = () => ({ status: 401, body: '{"error":"no"}' });

    await expect(servicio().analyze({ dni_front: foto() })).rejects.toThrow(
      /contestó 401/,
    );
  });

  it("un remoto que contesta cualquier cosa no explota con un error raro", async () => {
    responder = () => ({ status: 200, body: "<html>502 Bad Gateway</html>" });

    await expect(
      servicio().analyze({ dni_front: foto() }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("un ok:false del remoto propaga su mensaje, que es el diagnóstico", async () => {
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        ok: false,
        error: {
          code: "SIN_TESSERACT",
          message: "Falta el binario de tesseract.",
        },
      }),
    });

    await expect(servicio().analyze({ dni_front: foto() })).rejects.toThrow(
      /tesseract/,
    );
  });

  it("no se queda esperando para siempre a un remoto colgado", async () => {
    responder = () => ({ status: 200, body: "" });
    // Se cuelga sin contestar nunca.
    const colgado = createServer(() => {});
    await new Promise<void>((r) => colgado.listen(0, "127.0.0.1", r));
    const puerto = (colgado.address() as AddressInfo).port;

    try {
      const svc = servicio({
        DOCVERIFY_URL: `http://127.0.0.1:${puerto}`,
        DOCVERIFY_TIMEOUT_MS: "300",
      });
      await expect(svc.analyze({ dni_front: foto() })).rejects.toThrow(
        /el verificador remoto no contestó en 300 ms/,
      );
    } finally {
      await new Promise<void>((r) => colgado.close(() => r()));
    }
  });

  it("un remoto que no existe da un motivo entendible, no un stack", async () => {
    const svc = servicio({ DOCVERIFY_URL: "http://127.0.0.1:1" });
    await expect(svc.analyze({ dni_front: foto() })).rejects.toThrow(
      /no se pudo contactar al verificador remoto/,
    );
  });

  it("con DOCVERIFY_URL el servidor se considera capaz de verificar", async () => {
    await expect(servicio().available()).resolves.toBe(true);
    // Y probe() sale a preguntar de verdad.
    const probe = await servicio().probe();
    expect(probe.transport).toBe("remote");
  });
});
