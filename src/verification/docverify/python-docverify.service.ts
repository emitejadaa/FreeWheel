import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentSlot, DocverifyResponse } from "./docverify.types";

/**
 * EL PUENTE CON EL VERIFICADOR DE DOCUMENTOS
 *
 * Única puerta de entrada al verificador externo: le manda las fotos (en
 * base64, dentro de un JSON) a `DOCVERIFY_URL` y espera EL MISMO contrato de
 * vuelta (ver docverify.types.ts). Todavía no hay ningún verificador
 * implementado del otro lado — este servicio deja el cableado listo
 * (endpoint, timeout, token, diagnóstico) para cuando lo haya, sin acoplarse
 * a cómo esté hecho.
 *
 * Mientras `DOCVERIFY_URL` no esté configurada, `available()` da false y
 * `unavailableReason()` dice que falta: el módulo arranca en modo
 * "unavailable" y las submissions quedan FAILED con ese motivo, en vez de
 * encolarse solas en una revisión manual que nadie pidió.
 */
@Injectable()
export class PythonDocverifyService {
  private readonly logger = new Logger(PythonDocverifyService.name);

  constructor(private readonly config: ConfigService) {}

  private get timeoutMs(): number {
    return Number(this.config.get<string>("DOCVERIFY_TIMEOUT_MS")) || 120_000;
  }

  /** URL del verificador. Sin ella no hay forma de verificar automáticamente. */
  private get remoteUrl(): string | null {
    const url = this.config.get<string>("DOCVERIFY_URL")?.trim();
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** Clave compartida con el verificador, si está configurada. */
  private get remoteToken(): string | null {
    return this.config.get<string>("DOCVERIFY_TOKEN")?.trim() || null;
  }

  /**
   * ¿Puede este servidor correr una verificación automática? Alcanza con
   * tener la URL: NO se la consulta acá. Esto corre al arrancar y en
   * serverless cada arranque en frío pagaría el viaje de ida y vuelta. Si el
   * remoto está caído se ve al enviar un documento, con el error concreto en
   * el motivo. Sigue siendo `async` porque así lo espera quien llama
   * (arranca el módulo y también podría necesitar salir a la red el día que
   * haya más de un transporte).
   */
  available(): Promise<boolean> {
    return Promise.resolve(this.remoteUrl !== null);
  }

  /**
   * Por qué no se puede verificar acá, en una frase que se le puede mostrar a
   * quien está subiendo el documento y que además le sirve a quien administra
   * el servidor para saber qué falta.
   */
  unavailableReason(): string {
    return "no hay verificador de documentos configurado (falta DOCVERIFY_URL)";
  }

  /**
   * Diagnóstico en vivo: si el verificador configurado CONTESTA. A diferencia
   * de `available()`, este sí sale a la red — se llama a pedido, no al
   * arrancar.
   */
  async probe(): Promise<{
    transport: "remote" | "none";
    reachable: boolean;
    detail: string;
    /** Lo que contestó /health del verificador, si contestó. */
    remoteHealth: unknown;
  }> {
    if (!this.remoteUrl) {
      return {
        transport: "none",
        reachable: false,
        detail: this.unavailableReason(),
        remoteHealth: null,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${this.remoteUrl}/health`, {
        signal: controller.signal,
        headers: this.remoteToken
          ? { authorization: `Bearer ${this.remoteToken}` }
          : {},
      });
      const body: unknown = await response.json().catch(() => null);
      return {
        transport: "remote",
        reachable: response.ok,
        detail: response.ok
          ? "el verificador remoto contesta"
          : `el verificador remoto contestó ${response.status}`,
        remoteHealth: body,
      };
    } catch (error) {
      return {
        transport: "remote",
        reachable: false,
        detail:
          "no se pudo contactar al verificador remoto: " +
          (error instanceof Error ? error.message : String(error)),
        remoteHealth: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Analiza un juego de fotos (los bytes ya descargados del storage) y
   * devuelve el JSON del contrato. Falla con 503 si el verificador no está
   * disponible, se cuelga o contesta algo que no es el contrato — nunca con
   * un veredicto: eso lo decide quien llama.
   */
  async analyze(
    images: Partial<Record<DocumentSlot, Uint8Array>>,
  ): Promise<DocverifyResponse> {
    const slots = Object.keys(images) as DocumentSlot[];
    if (slots.length === 0) {
      throw new Error("PythonDocverifyService.analyze: sin imágenes");
    }

    if (!this.remoteUrl) {
      throw new ServiceUnavailableException(this.unavailableReason());
    }

    const raw = await this.runRemote(images, slots);
    return this.parseContract(raw);
  }

  /** El JSON crudo del verificador → el contrato, o 503 con el motivo. */
  private parseContract(raw: string): DocverifyResponse {
    let parsed: DocverifyResponse;
    try {
      parsed = JSON.parse(raw) as DocverifyResponse;
    } catch {
      this.logger.error(
        `El verificador contestó algo que no es JSON: ${raw.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        "El verificador de documentos contestó con un formato inesperado",
      );
    }

    if (!parsed.ok || !parsed.documentos) {
      this.logger.error(
        `El verificador reportó un fallo: ${JSON.stringify(parsed.error)}`,
      );
      throw new ServiceUnavailableException(
        parsed.error?.message ??
          "El verificador de documentos no pudo procesar el pedido",
      );
    }

    return parsed;
  }

  /**
   * Las fotos van en base64 dentro del JSON.
   *
   * Van en el cuerpo y no como archivos porque el que recibe es un servicio
   * aparte, sin disco compartido con este: no puede abrir una ruta nuestra.
   */
  private async runRemote(
    images: Partial<Record<DocumentSlot, Uint8Array>>,
    slots: DocumentSlot[],
  ): Promise<string> {
    const url = `${this.remoteUrl}/analyze`;
    const documentos: Record<string, string> = {};
    for (const slot of slots) {
      documentos[slot] = Buffer.from(images[slot] as Uint8Array).toString(
        "base64",
      );
    }

    // AbortSignal y no el timeout de un subproceso: acá el que se puede
    // colgar es el otro lado, y un fetch sin corte deja el request del
    // usuario abierto hasta que el proxy lo mate.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.remoteToken
            ? { authorization: `Bearer ${this.remoteToken}` }
            : {}),
        },
        body: JSON.stringify({ documentos }),
      });

      const body = await response.text();
      if (!response.ok) {
        this.logger.error(
          `El verificador remoto contestó ${response.status}: ${body.slice(0, 200)}`,
        );
        throw new ServiceUnavailableException(
          `el verificador remoto contestó ${response.status}`,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;

      // El corte por timeout se detecta por `name` y NO por `instanceof Error`:
      // fetch aborta con un DOMException, que en Node no es instancia de Error,
      // así que ese chequeo daba falso y el timeout salía como "no se pudo
      // contactar" — el diagnóstico exactamente al revés del real.
      const nombre =
        typeof error === "object" && error !== null && "name" in error
          ? String((error as { name: unknown }).name)
          : "";
      if (nombre === "AbortError" || nombre === "TimeoutError") {
        const detalle = `no contestó en ${this.timeoutMs} ms`;
        this.logger.error(`El verificador remoto ${detalle}`);
        throw new ServiceUnavailableException(
          `el verificador remoto ${detalle}`,
        );
      }

      const detalle = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `No se pudo hablar con el verificador remoto: ${detalle}`,
      );
      throw new ServiceUnavailableException(
        `no se pudo contactar al verificador remoto (${detalle})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
