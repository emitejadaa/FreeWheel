import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CloudinaryService } from "../../media/cloudinary.service";

/**
 * EL CLIENTE DE LA API QUE LEE DOCUMENTOS.
 *
 * La lectura de documentos corre en otro servicio, escrito en Python, que se
 * deploya aparte (ver docverify-api/). Este archivo es lo único de este
 * backend que le habla.
 *
 * ── Por qué es un servicio aparte y no una librería ──────────────────────────
 * Lo que hace falta para leer un DNI —OCR sobre ONNX, OpenCV, un decodificador
 * de PDF417— son unos 300 MB de dependencias nativas y modelos que hay que
 * tener cargados en memoria. Eso no entra en una función serverless (el tope
 * son 250 MB) y, aunque entrara, cada invocación volvería a levantar los
 * modelos desde cero. Necesita un proceso que viva entre pedidos, y este
 * backend no lo es.
 *
 * ── Por qué le avisa después en vez de contestar ─────────────────────────────
 * Un documento son dos caras, y cada cara son varios segundos de análisis que
 * no pueden correr en paralelo (dos análisis simultáneos no entran en la
 * memoria de una instancia chica). Esperar esa cuenta dentro del request del
 * usuario se pasa del minuto que dura como máximo una función serverless.
 *
 * Así que el trato es: le mandamos las dos fotos y una URL, nos contesta 202
 * enseguida, y cuando termina nos pega a esa URL. Cada salto HTTP dura pocos
 * segundos y ninguno de los dos lados espera al otro colgado.
 *
 * ── Por qué las imágenes van en base64 y no como URL ─────────────────────────
 * Las fotos viven en Cloudinary como assets privados. Se les puede armar una
 * URL firmada, pero esa firma NO VENCE: mandarla a otro servicio sería repartir
 * un acceso permanente al documento de identidad de una persona. Las bajamos
 * acá y mandamos los bytes, que existen mientras dura el request y nada más.
 *
 * ── Qué pasa cuando este servicio no está ────────────────────────────────────
 * Nada grave, y a propósito. Todos los fallos de acá se traducen a un motivo
 * con código y mensaje en castellano, y el documento sigue su camino por
 * revisión manual. La lectura automática ACELERA la verificación; no es la
 * única forma de verificarse. Un deploy caído no puede dejar a nadie sin poder
 * usar su cuenta.
 */

/** Documento completo, como lo nombra la API de lectura. */
export type DocverifyDocument = "dni" | "licencia";

/** Por qué no se pudo pedir el análisis. Cada caso tiene su arreglo distinto. */
export type DocverifyProblem =
  /** No hay DOCVERIFY_URL configurada: el deploy no tiene lectura automática. */
  | "NO_CONFIGURADO"
  /** No se pudieron bajar las fotos de Cloudinary. */
  | "DESCARGA_FALLIDA"
  /** No se llegó al servicio (caído, dormido, DNS, red). */
  | "INALCANZABLE"
  /** DOCVERIFY_URL está escrita de una forma que no es una URL. */
  | "URL_INVALIDA"
  /** Tardó más de lo aceptable en aceptar el pedido. */
  | "TIMEOUT"
  /** El token compartido está mal o falta. */
  | "NO_AUTORIZADO"
  /** El servicio está saturado y pidió reintentar más tarde. */
  | "SATURADO"
  /** Contestó algo que no esperábamos. */
  | "RESPUESTA_INESPERADA";

export interface DocverifyFailure {
  problem: DocverifyProblem;
  /** Explicación técnica, para el log y para `analysisError`. */
  detail: string;
  /**
   * Si volver a intentar el MISMO pedido puede salir bien.
   *
   * Existe por el caso más común de un deploy gratuito: el servicio se duerme
   * por inactividad y despertarlo tarda más de lo que podemos esperar, así que
   * el primer pedido después de un rato SIEMPRE se cae. Pero ese pedido lo
   * despertó, y el siguiente encuentra el servicio andando.
   *
   * Un token mal configurado, en cambio, va a seguir mal la próxima vez.
   */
  retryable: boolean;
}

export type DocverifyRequestResult =
  | { accepted: true }
  | { accepted: false; failure: DocverifyFailure };

/** Un campo leído, tal como lo devuelve el contrato de la API. */
export interface DocverifyField {
  valor: string;
  crudo: string;
  confianza: number;
}

/** Un método de lectura (ocr, pdf417, mrz, codigo_1d, qr) y lo que sacó. */
export interface DocverifySource {
  ok: boolean;
  disponible: boolean;
  error: string;
  campos: Record<string, DocverifyField>;
  detalle?: Record<string, unknown>;
}

/** El sobre de UNA cara. */
export interface DocverifyFace {
  ok: boolean;
  documento: string;
  origenes?: Record<string, DocverifySource>;
  error?: string;
}

/** El sobre del documento entero: las dos caras y sus cruces. */
export interface DocverifyResult {
  ok: boolean;
  documento: string;
  version: string;
  ms: number;
  caras: Record<string, DocverifyFace>;
  coincidencias: Record<
    string,
    {
      coinciden: boolean;
      corroborado: boolean;
      valores: string[];
      origenes: string[];
      por_origen: Record<string, string>;
    }
  >;
  error?: string;
}

/**
 * Cuánto esperamos a que la API ACEPTE el pedido (no a que lo termine).
 *
 * NO SE PUEDE SUBIR MUCHO, y conviene entender por qué antes de tocarlo. Este
 * request corre dentro de una función serverless con un tope duro de 60
 * segundos, que además tiene que cubrir la descarga de las dos fotos de
 * Cloudinary. Pasados esos 60 segundos la plataforma mata la función y el
 * usuario recibe un error, que es peor que este timeout controlado.
 *
 * Por eso un servicio dormido NO se resuelve esperándolo más: se resuelve
 * volviendo a intentar (ver `retryable` y el endpoint de reintento). El primer
 * pedido lo despierta aunque se caiga.
 */
const TIMEOUT_MS = Number(process.env.DOCVERIFY_TIMEOUT_MS ?? 30_000);

@Injectable()
export class DocverifyClient {
  private readonly logger = new Logger(DocverifyClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** ¿Este deploy tiene lectura automática configurada? */
  isConfigured(): boolean {
    return Boolean(this.baseUrl());
  }

  /**
   * Manda las dos caras de un documento a analizar y vuelve enseguida.
   *
   * No lanza nunca: cualquier problema vuelve como `accepted: false` con su
   * causa. Quien llama decide qué hacer, y en este backend lo que hace es
   * seguir con revisión manual.
   */
  async requestAnalysis(input: {
    document: DocverifyDocument;
    frontUrl: string;
    backUrl: string;
    reference: string;
    callbackUrl: string;
    callbackToken: string;
  }): Promise<DocverifyRequestResult> {
    const base = this.baseUrl();
    if (!base) {
      return {
        accepted: false,
        failure: {
          problem: "NO_CONFIGURADO",
          detail:
            "DOCVERIFY_URL no está configurada: este deploy no tiene lectura " +
            "automática de documentos",
          // Reintentar no va a hacer aparecer una variable de entorno.
          retryable: false,
        },
      };
    }

    // Un deploy apuntando a una dirección privada no tiene arreglo por
    // reintento, y el pedido no puede salir bien. Se corta ACÁ, antes de bajar
    // las dos fotos de Cloudinary, porque esperar 30 segundos a un timeout y
    // gastar dos descargas para llegar a la misma conclusión no le sirve a
    // nadie.
    const sinRuta = this.sinRutaDesdeUnDeploy(base);
    if (sinRuta) return { accepted: false, failure: sinRuta };

    let frente: string;
    let dorso: string;
    try {
      [frente, dorso] = await Promise.all([
        this.downloadAsBase64(input.frontUrl),
        this.downloadAsBase64(input.backUrl),
      ]);
    } catch (error) {
      return {
        accepted: false,
        failure: {
          problem: "DESCARGA_FALLIDA",
          detail: `no se pudieron bajar las fotos del documento: ${describe(error)}`,
          // Puede ser un hipo de red de Cloudinary, o que el archivo no esté.
          // Lo primero se arregla solo; lo segundo lo resuelve un admin.
          retryable: true,
        },
      };
    }

    const token = this.config.get<string>("DOCVERIFY_TOKEN")?.trim();
    // El token de la PLATAFORMA, cuando la hay. Un Space privado de Hugging
    // Face se protege con el suyo, que viaja en `Authorization`; el nuestro va
    // aparte, en `X-Docverify-Token`, para que los dos quepan en el mismo
    // pedido. Sin esta variable —un Space público— `Authorization` queda libre
    // y se manda ahí el nuestro, que es lo que espera cualquier otro host.
    const tokenPlataforma = this.config
      .get<string>("DOCVERIFY_PLATFORM_TOKEN")
      ?.trim();
    // AbortController y no solo el timeout de fetch: sin esto, un servicio que
    // acepta la conexión y después se queda callado deja el request colgado
    // hasta que lo mate la plataforma, y con él al usuario esperando.
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), TIMEOUT_MS);

    const pedido: RequestInit = {
      method: "POST",
      signal: corte.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Docverify-Token": token } : {}),
        ...(tokenPlataforma
          ? { Authorization: `Bearer ${tokenPlataforma}` }
          : token
            ? { Authorization: `Bearer ${token}` }
            : {}),
      },
      body: JSON.stringify({
        documento: input.document,
        frente_base64: frente,
        dorso_base64: dorso,
        referencia: input.reference,
        callback_url: input.callbackUrl,
        callback_token: input.callbackToken,
      }),
    };

    try {
      let response: Response | null = null;
      let ultimoError: unknown;

      // Normalmente una sola vuelta; ver `destinos()` para la de `localhost`.
      for (const destino of this.destinos(base)) {
        try {
          response = await fetch(`${destino}/analizar/documento`, pedido);
          break;
        } catch (error) {
          ultimoError = error;
          // El timeout ya se agotó, o el problema no es de conexión: probar la
          // otra dirección solo sumaría espera para fallar igual.
          if (corte.signal.aborted || !esFalloDeConexion(error)) break;
        }
      }

      if (!response) throw ultimoError;

      if (response.status === 202) {
        this.logger.log(
          `análisis de ${input.document} aceptado · ref=${input.reference}`,
        );
        return { accepted: true };
      }

      const cuerpo = (await response.text()).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        return {
          accepted: false,
          failure: {
            problem: "NO_AUTORIZADO",
            detail:
              "la API de lectura rechazó el token: revisá que DOCVERIFY_TOKEN " +
              "sea el mismo de los dos lados" +
              (tokenPlataforma
                ? ", y que DOCVERIFY_PLATFORM_TOKEN siga siendo válido"
                : ". Si el servicio está en un Space privado, hace falta " +
                  "además DOCVERIFY_PLATFORM_TOKEN"),
            // Un token mal puesto va a seguir mal la próxima vez.
            retryable: false,
          },
        };
      }
      if (response.status === 503 || response.status === 429) {
        return {
          accepted: false,
          failure: {
            problem: "SATURADO",
            detail: `la API de lectura está saturada: ${cuerpo}`,
            // Es exactamente "ahora no, probá más tarde".
            retryable: true,
          },
        };
      }
      return {
        accepted: false,
        failure: {
          problem: "RESPUESTA_INESPERADA",
          detail: `la API de lectura respondió ${response.status}: ${cuerpo}`,
          // No sabemos qué pasó; dar otra oportunidad es barato.
          retryable: true,
        },
      };
    } catch (error) {
      const abortado =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      return {
        accepted: false,
        failure: abortado
          ? {
              problem: "TIMEOUT",
              detail: `la API de lectura no respondió en ${TIMEOUT_MS / 1000}s`,
              // EL CASO DEL PLAN GRATUITO: el servicio estaba dormido y este
              // pedido lo despertó. Se cayó, pero no en vano.
              retryable: true,
            }
          : fallaDeRed(error, base),
      };
    } finally {
      clearTimeout(reloj);
    }
  }

  /**
   * La URL base, sin barra final.
   *
   * Se normaliza acá y no al usarla porque el valor lo escribe una persona en
   * un panel: pegar la URL con la barra del final es lo natural, y sin esto
   * terminaba pidiendo `https://host//analizar/documento`.
   */
  private baseUrl(): string {
    const crudo = (this.config.get<string>("DOCVERIFY_URL") ?? "")
      .trim()
      .replace(/\/+$/, "");
    return crudo ? conProtocolo(crudo) : "";
  }

  /**
   * Las direcciones a probar, en orden.
   *
   * Casi siempre es una sola. La excepción es `localhost`, que en una máquina
   * con IPv6 resuelve a `::1` ANTES que a `127.0.0.1`: uvicorn, por defecto,
   * escucha solo en `127.0.0.1`, así que el primer intento se va contra un
   * puerto cerrado. Node 20+ prueba las dos familias solo (Happy Eyeballs),
   * pero en Node 18 no, y el síntoma es un `ECONNREFUSED ::1:8000` que parece
   * "el servicio no está corriendo" cuando en realidad está perfecto.
   *
   * Por eso, y solo para `localhost`, se guarda `127.0.0.1` como segundo
   * intento. No se reescribe la variable: si el primero anda, ese se usa.
   */
  private destinos(base: string): string[] {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return [base];
    }
    if (url.hostname !== "localhost") return [base];

    const porIp = new URL(base);
    porIp.hostname = "127.0.0.1";
    return [base, porIp.toString().replace(/\/+$/, "")];
  }

  /**
   * Por qué este deploy no va a poder llegar a una dirección privada.
   *
   * `127.0.0.1` y `192.168.x.y` no existen fuera de la red de uno: un servidor
   * de Vercel que intente conectarse ahí se está apuntando A SÍ MISMO, y lo
   * que recibe es un `ECONNREFUSED` idéntico al de un servicio apagado. El
   * mensaje que sale de ahí —"revisá que la API esté levantada"— manda a mirar
   * la máquina equivocada: la API puede estar perfecta y encendida, y el
   * pedido no llega igual, porque no hay ruta.
   *
   * Devuelve null cuando no aplica, que es el caso normal.
   */
  private sinRutaDesdeUnDeploy(base: string): DocverifyFailure | null {
    const host = hostDe(base);
    if (host === null || !esLocal(host)) return null;

    // Solo señales que pone la plataforma: ninguna de estas existe en la
    // máquina de uno, así que no hay forma de que esto se dispare en un local
    // que anda bien. La lista es la misma de docverify-api/app/config.py.
    const plataforma = [
      "VERCEL",
      "VERCEL_URL",
      "RENDER_SERVICE_ID",
      "K_SERVICE",
      "FLY_APP_NAME",
    ].find((señal) => this.config.get<string>(señal)?.trim());
    if (!plataforma) return null;

    return {
      problem: "INALCANZABLE",
      // Los primeros 160 caracteres son los únicos que le llegan al usuario
      // (ver shortDetail), así que el qué hacer va adelante y el detalle atrás.
      detail:
        `DOCVERIFY_URL apunta a ${host}, que desde un deploy es el propio ` +
        "servidor y no tu máquina: exponé la API con un túnel y poné esa URL " +
        `(ver docverify-api/README.md). Detectado por ${plataforma}.`,
      // No hay reintento que agregue una ruta que no existe.
      retryable: false,
    };
  }

  /** Baja un asset privado de Cloudinary y lo devuelve en base64. */
  private async downloadAsBase64(url: string): Promise<string> {
    const asset = this.cloudinary.parseAssetUrl(url);
    if (!asset) {
      throw new Error(`la URL del documento no es de nuestro storage: ${url}`);
    }
    const { bytes } = await this.cloudinary.download(asset.publicId, {
      format: asset.format,
    });
    return Buffer.from(bytes).toString("base64");
  }
}

/**
 * Códigos que garantizan que la conexión NUNCA llegó a abrirse.
 *
 * La lista es corta a propósito, porque de esto depende si se reintenta contra
 * la otra dirección, y reintentar un pedido que el servicio SÍ recibió le hace
 * analizar el documento dos veces. En una instancia chica no entran dos
 * análisis a la vez: el duplicado le saca el lugar a otra persona.
 *
 * Por eso quedan afuera `ECONNRESET` y `ETIMEDOUT`: los dos pueden pasar
 * DESPUÉS de que el servicio recibió las fotos y se puso a trabajar.
 */
const CODIGOS_SIN_CONEXION = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** ¿Se puede afirmar que no se abrió la conexión, y entonces vale reintentar? */
function esFalloDeConexion(error: unknown): boolean {
  const codigo = codigoDeCadena(error);
  return codigo !== null && CODIGOS_SIN_CONEXION.has(codigo);
}

/** ¿Es un host de la misma máquina o de la red local? */
function esLocal(host: string): boolean {
  const limpio = host.replace(/^\[|\]$/g, "");
  return (
    limpio === "localhost" ||
    limpio.endsWith(".localhost") ||
    limpio === "::1" ||
    limpio === "0.0.0.0" ||
    /^127\./.test(limpio) ||
    /^10\./.test(limpio) ||
    /^192\.168\./.test(limpio) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(limpio)
  );
}

/**
 * Traduce un fallo de red al motivo concreto y a qué hacer al respecto.
 *
 * Existe porque `TypeError: fetch failed` —que es literalmente todo lo que
 * Node dice cuando no llega— no distingue entre un puerto cerrado, un nombre
 * que no resuelve y una URL mal escrita, y cada uno se arregla distinto. El
 * código de errno sale de la cadena de `cause` (ver `describe`).
 */
function fallaDeRed(error: unknown, base: string): DocverifyFailure {
  const detalle = describe(error);
  const codigo = codigoDeCadena(error);
  const host = hostDe(base);
  const local = host !== null && esLocal(host);

  // Una URL que ni siquiera se puede parsear. El caso típico es haberla
  // escrito sin protocolo: `localhost:8000` no es una URL con host
  // "localhost" y puerto 8000, es una URL con ESQUEMA "localhost", y Node la
  // rechaza con el mismo "fetch failed" de siempre. `conProtocolo()` ya evita
  // la mayoría de estos; si igual llegó acá, la variable está mal escrita.
  if (
    codigo === "ERR_INVALID_URL" ||
    /invalid url|failed to parse url|unknown scheme/i.test(detalle)
  ) {
    return {
      problem: "URL_INVALIDA",
      detail:
        `DOCVERIFY_URL no es una URL válida ("${base}"): ${detalle}. ` +
        'Tiene que incluir el protocolo, por ejemplo "http://127.0.0.1:8000".',
      // Reintentar con la misma variable mal escrita da lo mismo.
      retryable: false,
    };
  }

  if (codigo === "ECONNREFUSED") {
    return {
      problem: "INALCANZABLE",
      detail:
        `no hay nada escuchando en ${base}: ${detalle}. ` +
        (local
          ? "Revisá que la API de lectura (docverify-api/) esté levantada y " +
            "que escuche en ese mismo puerto. `npm run check:docverify` lo " +
            "prueba y dice qué falta."
          : "Revisá que el servicio esté desplegado y que DOCVERIFY_URL " +
            "apunte a su dirección pública."),
      retryable: true,
    };
  }

  if (codigo === "ENOTFOUND" || codigo === "EAI_AGAIN") {
    return {
      problem: "INALCANZABLE",
      detail:
        `no se pudo resolver el host de DOCVERIFY_URL ("${base}"): ${detalle}. ` +
        "Revisá que el nombre esté bien escrito.",
      // EAI_AGAIN es un DNS que no contestó a tiempo y suele arreglarse solo;
      // ENOTFOUND con un nombre mal escrito, no. No se puede distinguir acá,
      // y un reintento es barato.
      retryable: true,
    };
  }

  if (codigo === "EHOSTUNREACH" || codigo === "ENETUNREACH") {
    return {
      problem: "INALCANZABLE",
      detail:
        `no hay ruta hasta ${base}: ${detalle}. ` +
        (local
          ? "DOCVERIFY_URL apunta a una dirección privada: eso solo funciona " +
            "si este backend corre en la MISMA máquina que la API de lectura. " +
            "Un backend desplegado no puede alcanzarla."
          : "Puede ser un firewall o una red sin salida."),
      retryable: true,
    };
  }

  return {
    problem: "INALCANZABLE",
    detail: `no se pudo llegar a la API de lectura en ${base}: ${detalle}`,
    retryable: true,
  };
}

/** El host de una URL, o null si no se puede leer. */
function hostDe(base: string): string | null {
  try {
    return new URL(base).hostname;
  } catch {
    return null;
  }
}

/**
 * Completa el protocolo cuando la variable viene sin él.
 *
 * `DOCVERIFY_URL="localhost:8000"` es el error de tipeo más fácil de cometer y
 * el más difícil de ver: para `fetch` eso no es "localhost, puerto 8000" sino
 * una URL con un esquema llamado `localhost`, y falla con el genérico "fetch
 * failed" sin decir nunca que el problema era la variable.
 *
 * Se asume `http` para direcciones de la misma máquina o de la red local
 * —donde no suele haber TLS— y `https` para cualquier host de internet, que
 * es lo que usa cualquier servicio desplegado.
 */
function conProtocolo(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;

  // Sin `//`, `new URL` interpreta lo de antes de los dos puntos como esquema;
  // agregándolo se lee como lo que la persona quiso escribir.
  const host = hostDe(`http://${url}`);
  return `${host !== null && esLocal(host) ? "http" : "https"}://${url}`;
}

/**
 * El mensaje de un error desconocido, sin volcar un objeto entero al log.
 *
 * DESARMA LA CADENA DE `cause`, y no es un detalle cosmético. Cuando `fetch`
 * no llega a destino, Node tira siempre el mismo `TypeError: fetch failed`, y
 * el motivo real —que el puerto está cerrado, que el host no existe, que la
 * URL no se entiende— viaja colgado en `error.cause`. Quedarse con el mensaje
 * de arriba deja el log diciendo "fetch failed" y nada más, que es
 * exactamente lo que no sirve para arreglar nada.
 *
 * El código de errno (`ECONNREFUSED`, `ENOTFOUND`, ...) se agrega cuando el
 * mensaje no lo trae ya, porque es lo que distingue "no hay nadie escuchando"
 * de "ese nombre no resuelve".
 */
function describe(error: unknown): string {
  const partes: string[] = [];
  // Un `cause` que se apunte a sí mismo colgaría el bucle; con los vistos
  // alcanza para no confiar en que nunca pase.
  const vistos = new Set<unknown>();
  let actual: unknown = error;

  while (actual instanceof Error && !vistos.has(actual)) {
    vistos.add(actual);

    const codigo = codigoDe(actual);
    const texto =
      codigo && !actual.message.includes(codigo)
        ? `${actual.message} (${codigo})`
        : actual.message;
    if (texto && !partes.includes(texto)) partes.push(texto);

    // Happy Eyeballs prueba IPv6 e IPv4 a la vez y, cuando fallan las dos,
    // junta los dos errores acá. El primero alcanza para el diagnóstico.
    const agrupados = (actual as AggregateError).errors;
    actual =
      actual.cause ??
      (Array.isArray(agrupados) && agrupados.length > 0 ? agrupados[0] : null);
  }

  // Casi siempre `cause` es un Error, pero nada obliga a que lo sea: si quedó
  // un string con la explicación, entra igual.
  if (typeof actual === "string" && actual && !partes.includes(actual)) {
    partes.push(actual);
  }

  return partes.length > 0 ? partes.join(": ") : String(error);
}

/** El `code` de un error de Node (`ECONNREFUSED`, ...), si lo tiene. */
function codigoDe(error: Error): string | null {
  const codigo = (error as NodeJS.ErrnoException).code;
  return typeof codigo === "string" && codigo ? codigo : null;
}

/**
 * El primer código de errno de toda la cadena.
 *
 * Es lo que decide el mensaje que se le muestra a quien tiene que arreglarlo:
 * el error de arriba es siempre el mismo `TypeError` genérico, así que el
 * código hay que ir a buscarlo adentro.
 */
function codigoDeCadena(error: unknown): string | null {
  const vistos = new Set<unknown>();
  let actual: unknown = error;

  while (actual instanceof Error && !vistos.has(actual)) {
    vistos.add(actual);
    const codigo = codigoDe(actual);
    if (codigo) return codigo;
    const agrupados = (actual as AggregateError).errors;
    actual =
      actual.cause ??
      (Array.isArray(agrupados) && agrupados.length > 0 ? agrupados[0] : null);
  }
  return null;
}
