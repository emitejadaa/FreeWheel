import { ConfigService } from "@nestjs/config";
import { CloudinaryService } from "../../media/cloudinary.service";
import { DocverifyClient } from "./docverify.client";

/**
 * LO QUE ESTE ARCHIVO CUIDA es que cuando la API de lectura no contesta, el
 * backend diga POR QUÉ.
 *
 * Node tira siempre el mismo `TypeError: fetch failed` cuando no llega a
 * destino, y el motivo real —puerto cerrado, host que no resuelve, URL mal
 * escrita— viaja escondido en `error.cause`. Un log que dice "fetch failed" y
 * nada más no permite arreglar ninguna de esas tres cosas, que se arreglan
 * distinto. Los tests de acá son esas situaciones.
 */

/** El error que tira `fetch` cuando no puede abrir la conexión. */
function fetchFallado(codigo: string, mensaje: string): TypeError {
  const causa = new Error(mensaje) as NodeJS.ErrnoException;
  causa.code = codigo;
  return new TypeError("fetch failed", { cause: causa });
}

/** Un cliente con las variables de entorno que se le pasen. */
function cliente(env: Record<string, string | undefined>) {
  const config = {
    get: (clave: string) => env[clave],
  } as unknown as ConfigService;

  // Las fotos se bajan de Cloudinary antes de llamar a la API; acá no es lo
  // que se está probando, así que devuelve bytes y listo.
  const cloudinary = {
    parseAssetUrl: () => ({ publicId: "doc", format: "jpg" }),
    download: () => Promise.resolve({ bytes: Buffer.from("foto") }),
  } as unknown as CloudinaryService;

  return new DocverifyClient(config, cloudinary);
}

const PEDIDO = {
  document: "dni" as const,
  frontUrl: "https://res.cloudinary.com/demo/image/upload/frente.jpg",
  backUrl: "https://res.cloudinary.com/demo/image/upload/dorso.jpg",
  reference: "ref-1",
  callbackUrl: "http://localhost:3000/verification/identity/analysis-callback",
  callbackToken: "token-de-vuelta",
};

/** Lo que se le pidió a `fetch` en cada llamada. */
let llamadas: string[];

beforeEach(() => {
  llamadas = [];
  jest.restoreAllMocks();
});

/** Reemplaza `fetch` por algo que anota la URL y responde lo que se le diga. */
function interceptar(responder: (url: string) => Promise<Response>) {
  jest
    .spyOn(globalThis, "fetch")
    .mockImplementation((entrada: RequestInfo | URL) => {
      const url =
        typeof entrada === "string"
          ? entrada
          : entrada instanceof URL
            ? entrada.href
            : entrada.url;
      llamadas.push(url);
      return responder(url);
    });
}

describe("cuando no se llega a la API de lectura", () => {
  it("dice que el puerto está cerrado, y no solo 'fetch failed'", async () => {
    interceptar(() =>
      Promise.reject(
        fetchFallado("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8000"),
      ),
    );

    const resultado = await cliente({
      DOCVERIFY_URL: "http://127.0.0.1:8000",
    }).requestAnalysis(PEDIDO);

    expect(resultado.accepted).toBe(false);
    if (resultado.accepted) return;

    // El motivo real, el que estaba escondido en `cause`.
    expect(resultado.failure.detail).toContain("ECONNREFUSED");
    expect(resultado.failure.detail).toContain("127.0.0.1:8000");
    // Y qué hacer al respecto.
    expect(resultado.failure.detail).toContain("docverify-api/");
    expect(resultado.failure.detail).toContain("check:docverify");
    expect(resultado.failure.problem).toBe("INALCANZABLE");
    expect(resultado.failure.retryable).toBe(true);
  });

  it("distingue un host que no resuelve de un puerto cerrado", async () => {
    interceptar(() =>
      Promise.reject(
        fetchFallado("ENOTFOUND", "getaddrinfo ENOTFOUND no-existe.local"),
      ),
    );

    const resultado = await cliente({
      DOCVERIFY_URL: "https://no-existe.local",
    }).requestAnalysis(PEDIDO);

    if (resultado.accepted) throw new Error("no debería haber sido aceptado");
    expect(resultado.failure.detail).toContain("no se pudo resolver el host");
    expect(resultado.failure.detail).toContain("ENOTFOUND");
  });

  it("avisa que una dirección privada no se alcanza desde un deploy", async () => {
    interceptar(() =>
      Promise.reject(
        fetchFallado("EHOSTUNREACH", "connect EHOSTUNREACH 192.168.0.10:8000"),
      ),
    );

    const resultado = await cliente({
      DOCVERIFY_URL: "http://192.168.0.10:8000",
    }).requestAnalysis(PEDIDO);

    if (resultado.accepted) throw new Error("no debería haber sido aceptado");
    expect(resultado.failure.detail).toContain("MISMA máquina");
  });

  it("señala la variable cuando la URL no se puede ni parsear", async () => {
    // Lo que tira Node ante una URL que no entiende: el "fetch failed" de
    // siempre, con el motivo colgado en `cause`.
    interceptar(() =>
      Promise.reject(
        new TypeError("fetch failed", { cause: new TypeError("Invalid URL") }),
      ),
    );

    const resultado = await cliente({
      DOCVERIFY_URL: "http://[mal]:8000",
    }).requestAnalysis(PEDIDO);

    if (resultado.accepted) throw new Error("no debería haber sido aceptado");
    expect(resultado.failure.problem).toBe("URL_INVALIDA");
    expect(resultado.failure.detail).toContain("DOCVERIFY_URL");
    // Insistir con una variable mal escrita no puede salir bien.
    expect(resultado.failure.retryable).toBe(false);
  });
});

describe("DOCVERIFY_URL escrita a mano", () => {
  it("completa http:// cuando falta y la dirección es local", async () => {
    interceptar(() => Promise.resolve(new Response("", { status: 202 })));

    // "localhost:8000" NO es host+puerto para `fetch`: es un esquema llamado
    // "localhost", y falla con el mismo "fetch failed" de siempre.
    const resultado = await cliente({
      DOCVERIFY_URL: "localhost:8000",
    }).requestAnalysis(PEDIDO);

    expect(resultado.accepted).toBe(true);
    expect(llamadas[0]).toBe("http://localhost:8000/analizar/documento");
  });

  it("asume https:// para un host de internet", async () => {
    interceptar(() => Promise.resolve(new Response("", { status: 202 })));

    await cliente({
      DOCVERIFY_URL: "docverify.onrender.com",
    }).requestAnalysis(PEDIDO);

    expect(llamadas[0]).toBe(
      "https://docverify.onrender.com/analizar/documento",
    );
  });

  it("le saca la barra del final", async () => {
    interceptar(() => Promise.resolve(new Response("", { status: 202 })));

    await cliente({
      DOCVERIFY_URL: "http://127.0.0.1:8000/",
    }).requestAnalysis(PEDIDO);

    expect(llamadas[0]).toBe("http://127.0.0.1:8000/analizar/documento");
  });
});

describe("localhost en una máquina con IPv6", () => {
  it("reintenta por 127.0.0.1 cuando ::1 tiene el puerto cerrado", async () => {
    // uvicorn escucha en 127.0.0.1; `localhost` resuelve primero a ::1.
    interceptar((url) =>
      url.includes("localhost")
        ? Promise.reject(
            fetchFallado("ECONNREFUSED", "connect ECONNREFUSED ::1:8000"),
          )
        : Promise.resolve(new Response("", { status: 202 })),
    );

    const resultado = await cliente({
      DOCVERIFY_URL: "http://localhost:8000",
    }).requestAnalysis(PEDIDO);

    expect(resultado.accepted).toBe(true);
    expect(llamadas).toEqual([
      "http://localhost:8000/analizar/documento",
      "http://127.0.0.1:8000/analizar/documento",
    ]);
  });

  it("no reintenta si el problema no es de conexión", async () => {
    interceptar(() => Promise.reject(new TypeError("body already read")));

    await cliente({ DOCVERIFY_URL: "http://localhost:8000" }).requestAnalysis(
      PEDIDO,
    );

    // Una sola: probar la otra dirección iba a fallar igual.
    expect(llamadas).toHaveLength(1);
  });
});

describe("lo que ya funcionaba sigue funcionando", () => {
  it("sin DOCVERIFY_URL no pide nada y lo dice", async () => {
    const resultado = await cliente({}).requestAnalysis(PEDIDO);

    if (resultado.accepted) throw new Error("no debería haber sido aceptado");
    expect(resultado.failure.problem).toBe("NO_CONFIGURADO");
    expect(resultado.failure.retryable).toBe(false);
  });

  it("manda el token compartido en los dos headers que la API acepta", async () => {
    let headers: Headers | undefined;
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return Promise.resolve(new Response("", { status: 202 }));
      });

    await cliente({
      DOCVERIFY_URL: "http://127.0.0.1:8000",
      DOCVERIFY_TOKEN: "secreto",
    }).requestAnalysis(PEDIDO);

    expect(headers?.get("X-Docverify-Token")).toBe("secreto");
    expect(headers?.get("Authorization")).toBe("Bearer secreto");
  });

  it("un 401 se reporta como token mal configurado y no se reintenta", async () => {
    interceptar(() => Promise.resolve(new Response("nope", { status: 401 })));

    const resultado = await cliente({
      DOCVERIFY_URL: "http://127.0.0.1:8000",
      DOCVERIFY_TOKEN: "secreto",
    }).requestAnalysis(PEDIDO);

    if (resultado.accepted) throw new Error("no debería haber sido aceptado");
    expect(resultado.failure.problem).toBe("NO_AUTORIZADO");
    expect(resultado.failure.retryable).toBe(false);
  });
});

describe("no reintentar lo que el servicio pudo haber recibido", () => {
  // Reintentar un pedido que la API SÍ recibió le hace analizar el documento
  // dos veces, y no entran dos análisis a la vez en una instancia chica.
  it.each(["ECONNRESET", "ETIMEDOUT"])(
    "no reintenta ante %s, que puede pasar con el pedido ya entregado",
    async (codigo) => {
      interceptar(() =>
        Promise.reject(fetchFallado(codigo, `socket hang up ${codigo}`)),
      );

      await cliente({ DOCVERIFY_URL: "http://localhost:8000" }).requestAnalysis(
        PEDIDO,
      );

      expect(llamadas).toHaveLength(1);
    },
  );
});
