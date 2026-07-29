import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

// Tope del audio a transcribir (los mensajes de voz del chat son cortos).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Documentos que sabe revisar inspectDocument(). */
export type DocumentKind =
  | "DNI_FRONT"
  | "DNI_BACK"
  | "LICENSE_FRONT"
  | "LICENSE_BACK";

const DOCUMENT_PROMPTS: Record<DocumentKind, string> = {
  DNI_FRONT:
    "el FRENTE de un documento nacional de identidad (DNI), con la foto de la persona, su nombre y el número de documento",
  DNI_BACK:
    "el DORSO de un documento nacional de identidad (DNI), con datos como domicilio, fecha de emisión o código de barras",
  LICENSE_FRONT:
    "el FRENTE de una licencia de conducir, con la foto de la persona, su nombre y el número de licencia",
  LICENSE_BACK:
    "el DORSO de una licencia de conducir, con las categorías habilitadas y/o la fecha de vencimiento",
};

/**
 * Por qué no se pudo revisar una imagen. Se devuelve al front para que pueda
 * distinguir "el servicio no está configurado" (falta la GROQ_API_KEY en el
 * servidor) de "el proveedor falló": son dos problemas muy distintos y antes los
 * dos llegaban como un genérico "no se pudo revisar".
 */
export type AiUnavailableCode =
  | "not_configured"
  | "upstream_error"
  | "unreadable";

export interface DocumentInspection {
  /** true = corresponde, false = no corresponde, null = no se pudo revisar. */
  matches: boolean | null;
  reason: string;
  /** Solo cuando matches es null: por qué no se pudo revisar. */
  code?: AiUnavailableCode;
  detectedType?: string | null;
  documentNumber?: string | null;
  fullName?: string | null;
  expiresAt?: string | null;
}

/** Recorta el JSON de una respuesta que puede venir con texto alrededor. */
function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const asText = (value: unknown): string | null =>
  typeof value === "string" &&
  value.trim() &&
  value.trim().toLowerCase() !== "null"
    ? value.trim().slice(0, 160)
    : null;

const asDigits = (value: unknown): string | null => {
  const text = asText(value);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 20) : null;
};

const asDate = (value: unknown): string | null => {
  const text = asText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isNaN(new Date(`${text}T00:00:00.000Z`).getTime())
    ? null
    : text;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string {
    const key = this.config.get<string>("GROQ_API_KEY");
    if (!key) {
      throw new ServiceUnavailableException(
        "El servicio de IA no está configurado",
      );
    }
    return key;
  }

  /** ¿Está cargada la clave? Sin ella no se puede llamar al proveedor. */
  private get configured(): boolean {
    return Boolean(this.config.get<string>("GROQ_API_KEY"));
  }

  /**
   * Manda una imagen al modelo de visión y devuelve el texto de la respuesta.
   *
   * Centraliza el manejo de errores de las dos funciones que ven imágenes
   * (revisar documentos y verificar que la foto sea un auto). Es importante que
   * el motivo del fallo llegue con nombre propio: antes, si faltaba la
   * GROQ_API_KEY, la excepción se comía el catch de más arriba y la pantalla
   * mostraba "no se pudo revisar" sin decir que en realidad faltaba configurar
   * el servidor. Además el error del proveedor se registra completo en el log,
   * que es lo único que se puede leer desde el panel del deploy.
   */
  private async askVisionModel(
    imageUrl: string,
    prompt: string,
    maxTokens: number,
  ): Promise<
    { ok: true; content: string } | { ok: false; code: AiUnavailableCode }
  > {
    if (!this.configured) {
      this.logger.error(
        "Falta GROQ_API_KEY: la revisión por IA queda deshabilitada. " +
          "Cargala en las variables de entorno del backend.",
      );
      return { ok: false, code: "not_configured" };
    }

    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey()}`,
        },
        body: JSON.stringify({
          model: VISION_MODEL,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl } },
                { type: "text", text: prompt },
              ],
            },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        // El cuerpo del error dice lo que hace falta para arreglarlo (clave
        // inválida, modelo dado de baja, imagen demasiado grande).
        const detail = await res.text().catch(() => "");
        this.logger.error(
          `Groq visión respondió ${res.status}: ${detail.slice(0, 500)}`,
        );
        return { ok: false, code: "upstream_error" };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return { ok: true, content: data.choices?.[0]?.message?.content ?? "" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Groq visión falló: ${message}`);
      return { ok: false, code: "upstream_error" };
    }
  }

  async chat(
    messages: unknown[],
    temperature = 0.7,
  ): Promise<{ content: string }> {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new BadGatewayException(
        err.error?.message || `Groq error ${res.status}`,
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return { content: data.choices?.[0]?.message?.content ?? "" };
  }

  /**
   * Audio → texto (Whisper) para las notas de voz del chat.
   *
   * Recibe la URL del audio ya subido (Cloudinary), lo descarga acá y lo manda a
   * Groq. Antes esto se hacía desde el navegador con la clave de la IA a la
   * vista en el bundle: la clave vive solo en el servidor.
   */
  async transcribe(audioUrl: string): Promise<{ text: string }> {
    const apiKey = this.apiKey();

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new BadRequestException("No se pudo descargar el audio");
    }

    const audio = await audioResponse.blob();
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        "El audio es demasiado grande para transcribir",
      );
    }

    const form = new FormData();
    form.append("file", audio, "audio.webm");
    form.append("model", TRANSCRIBE_MODEL);
    form.append("language", "es");
    form.append("response_format", "json");

    // Sin Content-Type manual: fetch agrega el boundary del multipart.
    const res = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new BadGatewayException(
        err.error?.message || `Groq error ${res.status}`,
      );
    }

    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? "").trim() };
  }

  /**
   * Revisa con IA si una foto es realmente el documento que se pidió, y extrae
   * los datos que se ven en él.
   *
   * Es lo que evita que se suba "cualquier foto" como DNI o licencia: el modelo
   * mira la imagen y responde si corresponde al tipo de documento esperado, si
   * es legible, y qué número y nombre figuran. Con eso el backend puede aprobar
   * o rechazar la verificación y guardar los datos en la base.
   *
   * Devuelve `matches: null` cuando la IA no está disponible: en ese caso el
   * llamador decide (no se toma como rechazo).
   */
  async inspectDocument(
    imageUrl: string,
    kind: DocumentKind,
  ): Promise<DocumentInspection> {
    const expected = DOCUMENT_PROMPTS[kind];

    const answer = await this.askVisionModel(
      imageUrl,
      `Analizá la imagen. Se espera ${expected}.\n` +
        "Respondé SOLO un JSON válido, sin texto alrededor, con esta forma exacta:\n" +
        '{"corresponde": true|false, "legible": true|false, ' +
        '"tipo_detectado": "texto corto", "numero": "solo dígitos o null", ' +
        '"nombre": "nombre completo o null", "vencimiento": "YYYY-MM-DD o null", ' +
        '"motivo": "una frase explicando la decisión"}\n' +
        "Si la imagen no es un documento de identidad (por ejemplo un paisaje, " +
        "una mascota, una captura de pantalla o una persona sin documento), " +
        '"corresponde" debe ser false.',
      400,
    );

    if (!answer.ok) {
      return {
        matches: null,
        code: answer.code,
        reason:
          answer.code === "not_configured"
            ? "La revisión automática no está configurada en el servidor."
            : "La revisión automática no está disponible en este momento.",
      };
    }

    const parsed = extractJson(answer.content);
    if (!parsed) {
      return {
        matches: null,
        code: "unreadable",
        reason: "No se pudo interpretar la revisión automática.",
      };
    }

    const matches = parsed.corresponde === true && parsed.legible !== false;
    return {
      matches,
      reason:
        typeof parsed.motivo === "string" && parsed.motivo
          ? parsed.motivo
          : matches
            ? "El documento coincide con lo esperado."
            : "La imagen no corresponde al documento pedido.",
      detectedType: asText(parsed.tipo_detectado),
      documentNumber: asDigits(parsed.numero),
      fullName: asText(parsed.nombre),
      expiresAt: asDate(parsed.vencimiento),
    };
  }

  /**
   * ¿La foto muestra un vehículo? Se usa al publicar un auto para no dejar subir
   * fotos que no correspondan.
   *
   * `isVehicle` en null significa "no se pudo verificar", y `code` dice por qué:
   * así la pantalla puede avisar que falta configurar el servidor en vez de
   * quedarse en un silencioso "no verificada".
   */
  async vision(
    imageDataUrl: string,
  ): Promise<{ isVehicle: boolean | null; code?: AiUnavailableCode }> {
    const answer = await this.askVisionModel(
      imageDataUrl,
      "¿Esta imagen muestra un automóvil, camioneta, SUV, moto u otro vehículo de motor? Respondé únicamente SI o NO.",
      5,
    );

    if (!answer.ok) return { isVehicle: null, code: answer.code };

    const text = answer.content.trim().toUpperCase();
    if (text.startsWith("SI")) return { isVehicle: true };
    if (text.startsWith("NO")) return { isVehicle: false };
    return { isVehicle: null, code: "unreadable" };
  }
}
