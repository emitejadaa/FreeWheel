import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, rm, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentSlot, DocverifyResponse } from "./docverify.types";

/**
 * EL PUENTE CON EL VERIFICADOR PYTHON
 *
 * Única puerta de entrada al subproyecto python-verifier/: escribe las fotos
 * en un directorio temporal privado, ejecuta `analyze.py` como subproceso
 * (JSON por stdin → JSON por stdout) y borra el temporal pase lo que pase.
 *
 * Aislamiento a propósito:
 * - el subproceso no recibe NINGÚN dato del usuario por argv (solo rutas de
 *   archivo generadas por este servicio con randomUUID);
 * - el verificador no abre puertos ni sale a la red: no hay forma de llegar
 *   a él más que por este servicio, y este servicio solo lo usa el flujo de
 *   verificación de documentos;
 * - timeout duro con kill: un análisis colgado nunca deja el request vivo.
 *
 * DOS TRANSPORTES, EL MISMO CONTRATO
 *
 * 1. SUBPROCESO (local): ejecuta `analyze.py` del subproyecto. Es lo de
 *    siempre y no necesita nada más que el venv y tesseract instalados.
 *
 * 2. HTTP (`DOCVERIFY_URL`): le manda las fotos a un verificador corriendo en
 *    otro lado y recibe EL MISMO JSON. Existe porque en serverless —Vercel, que
 *    es donde está el deploy— no hay Python ni el binario de tesseract y no los
 *    puede haber: son dependencias del sistema operativo, no paquetes npm. Sin
 *    esto la verificación automática NO PUEDE correr en el deploy, y todo
 *    documento termina esperando a un admin.
 *    El verificador se despliega aparte (ver python-verifier/Dockerfile y
 *    python-verifier/server.py) y esta variable apunta a él.
 *
 * Cuando ninguno de los dos está disponible, `available()` da false y
 * `unavailableReason()` dice cuál falta: el módulo arranca en modo
 * "unavailable" y las submissions quedan FAILED con ese motivo, en vez de
 * encolarse solas en una revisión manual que nadie pidió.
 */
@Injectable()
export class PythonDocverifyService {
  private readonly logger = new Logger(PythonDocverifyService.name);

  constructor(private readonly config: ConfigService) {}

  /** Carpeta del subproyecto. DOCVERIFY_DIR la sobreescribe. */
  private get projectDir(): string {
    return (
      this.config.get<string>("DOCVERIFY_DIR") ||
      path.join(process.cwd(), "python-verifier")
    );
  }

  /**
   * Binario de Python. DOCVERIFY_PYTHON la sobreescribe; por defecto el
   * venv del subproyecto (donde viven las dependencias instaladas).
   */
  private get pythonBin(): string {
    return (
      this.config.get<string>("DOCVERIFY_PYTHON") ||
      path.join(this.projectDir, ".venv", "bin", "python")
    );
  }

  private get timeoutMs(): number {
    return Number(this.config.get<string>("DOCVERIFY_TIMEOUT_MS")) || 120_000;
  }

  /**
   * URL de un verificador corriendo en otro servidor. Cuando está, se usa en
   * lugar del subproceso: es el único camino posible en serverless.
   */
  private get remoteUrl(): string | null {
    const url = this.config.get<string>("DOCVERIFY_URL")?.trim();
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** Clave compartida con el verificador remoto, si está configurada. */
  private get remoteToken(): string | null {
    return this.config.get<string>("DOCVERIFY_TOKEN")?.trim() || null;
  }

  /** ¿Puede este servidor correr una verificación automática? */
  async available(): Promise<boolean> {
    // Con verificador remoto alcanza con tener la URL: NO se lo consulta acá.
    // Esto corre al arrancar y en serverless cada arranque en frío pagaría el
    // viaje de ida y vuelta. Si el remoto está caído se ve al enviar un
    // documento, con el error concreto en el motivo.
    if (this.remoteUrl) return true;

    return this.localAvailable();
  }

  private async localAvailable(): Promise<boolean> {
    try {
      await access(path.join(this.projectDir, "analyze.py"));
      await access(this.pythonBin);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Por qué no se puede verificar acá, en una frase que se le puede mostrar a
   * quien está subiendo el documento y que además le sirve a quien administra
   * el servidor para saber qué falta.
   */
  unavailableReason(): string {
    return (
      "no hay verificador de documentos configurado (ni Python local en " +
      `${this.projectDir}, ni DOCVERIFY_URL apuntando a uno remoto)`
    );
  }

  /**
   * Diagnóstico en vivo: qué transporte hay y si CONTESTA. A diferencia de
   * `available()`, este sí sale a la red — se llama a pedido, no al arrancar.
   *
   * Existe porque "la verificación no anda" tenía demasiadas causas posibles
   * (falta Python, falta tesseract, el remoto está caído, el token no coincide)
   * y ninguna forma de distinguirlas sin entrar al servidor.
   */
  async probe(): Promise<{
    transport: "remote" | "local" | "none";
    reachable: boolean;
    detail: string;
    /** Lo que contestó /health del verificador remoto, si contestó. */
    remoteHealth: unknown;
  }> {
    if (this.remoteUrl) {
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

    if (await this.localAvailable()) {
      return {
        transport: "local",
        reachable: true,
        detail: `Python local en ${this.projectDir}`,
        remoteHealth: null,
      };
    }

    return {
      transport: "none",
      reachable: false,
      detail: this.unavailableReason(),
      remoteHealth: null,
    };
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

    const raw = this.remoteUrl
      ? await this.runRemote(images, slots)
      : await this.runLocal(images, slots);

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
   * Verificador remoto: las fotos van en base64 dentro del JSON.
   *
   * Van en el cuerpo y no como archivos porque el que recibe es un servicio
   * aparte, sin disco compartido con este: no puede abrir una ruta nuestra. El
   * contrato de respuesta es EL MISMO que el del subproceso, así que a partir
   * de acá el resto del flujo no distingue por dónde vino.
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

    // AbortSignal y no el timeout del subproceso: acá el que se puede colgar es
    // el otro lado, y un fetch sin corte deja el request del usuario abierto
    // hasta que el proxy lo mate.
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

  /** Verificador local: las fotos se escriben a un temporal y se ejecuta el script. */
  private async runLocal(
    images: Partial<Record<DocumentSlot, Uint8Array>>,
    slots: DocumentSlot[],
  ): Promise<string> {
    const workDir = await mkdtemp(path.join(tmpdir(), "docverify-"));
    try {
      const documentos: Record<string, string> = {};
      for (const slot of slots) {
        const file = path.join(workDir, `${slot}-${randomUUID()}.jpg`);
        await writeFile(file, images[slot] as Uint8Array, { mode: 0o600 });
        documentos[slot] = file;
      }

      return await this.run(JSON.stringify({ documentos }));
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        this.logger.warn(`No se pudo borrar el temporal ${workDir}`);
      });
    }
  }

  /** Ejecuta analyze.py con el pedido por stdin y devuelve su stdout. */
  private run(requestJson: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, ["analyze.py"], {
        cwd: this.projectDir,
        stdio: ["pipe", "pipe", "pipe"],
        // Entorno mínimo: el verificador no necesita ninguna variable del
        // backend (ni claves, ni base de datos).
        env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(
          new ServiceUnavailableException(
            `El verificador de documentos no terminó en ${this.timeoutMs} ms`,
          ),
        );
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // stderr trae warnings de las librerías; solo se loguea.
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.logger.error(
          `No se pudo ejecutar el verificador: ${error.message}`,
        );
        reject(
          new ServiceUnavailableException(
            "El verificador de documentos no está disponible en este servidor",
          ),
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stderr.trim()) {
          this.logger.debug(`stderr del verificador: ${stderr.slice(0, 500)}`);
        }
        if (code !== 0 && !stdout) {
          reject(
            new ServiceUnavailableException(
              `El verificador de documentos terminó con código ${code}`,
            ),
          );
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(requestJson);
      child.stdin.end();
    });
  }
}
