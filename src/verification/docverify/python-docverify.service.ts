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
 * En un entorno sin Python (p. ej. Vercel serverless) `available()` da
 * false y el módulo cae a modo manual: las verificaciones esperan a un
 * admin en vez de romper el deploy.
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

  /** ¿Está el verificador instalado en este entorno? */
  async available(): Promise<boolean> {
    try {
      await access(path.join(this.projectDir, "analyze.py"));
      await access(this.pythonBin);
      return true;
    } catch {
      return false;
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

    const workDir = await mkdtemp(path.join(tmpdir(), "docverify-"));
    try {
      const documentos: Record<string, string> = {};
      for (const slot of slots) {
        const file = path.join(workDir, `${slot}-${randomUUID()}.jpg`);
        await writeFile(file, images[slot] as Uint8Array, { mode: 0o600 });
        documentos[slot] = file;
      }

      const raw = await this.run(JSON.stringify({ documentos }));

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
          "El verificador de documentos no pudo procesar el pedido",
        );
      }

      return parsed;
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
