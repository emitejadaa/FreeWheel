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

/** Cuánto esperamos a que la API ACEPTE el pedido (no a que lo termine). */
const TIMEOUT_MS = 30_000;

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
        },
      };
    }

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
        },
      };
    }

    const token = this.config.get<string>("DOCVERIFY_TOKEN")?.trim();
    // AbortController y no solo el timeout de fetch: sin esto, un servicio que
    // acepta la conexión y después se queda callado deja el request colgado
    // hasta que lo mate la plataforma, y con él al usuario esperando.
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${base}/analizar/documento`, {
        method: "POST",
        signal: corte.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          documento: input.document,
          frente_base64: frente,
          dorso_base64: dorso,
          referencia: input.reference,
          callback_url: input.callbackUrl,
          callback_token: input.callbackToken,
        }),
      });

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
              "sea el mismo de los dos lados",
          },
        };
      }
      if (response.status === 503 || response.status === 429) {
        return {
          accepted: false,
          failure: {
            problem: "SATURADO",
            detail: `la API de lectura está saturada: ${cuerpo}`,
          },
        };
      }
      return {
        accepted: false,
        failure: {
          problem: "RESPUESTA_INESPERADA",
          detail: `la API de lectura respondió ${response.status}: ${cuerpo}`,
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
            }
          : {
              problem: "INALCANZABLE",
              detail: `no se pudo llegar a la API de lectura: ${describe(error)}`,
            },
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
    return (this.config.get<string>("DOCVERIFY_URL") ?? "")
      .trim()
      .replace(/\/+$/, "");
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

/** El mensaje de un error desconocido, sin volcar un objeto entero al log. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
