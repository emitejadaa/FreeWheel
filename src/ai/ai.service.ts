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

export interface DocumentInspection {
  /** true = corresponde, false = no corresponde, null = no se pudo revisar. */
  matches: boolean | null;
  reason: string;
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
                {
                  type: "text",
                  text:
                    `Analizá la imagen. Se espera ${expected}.\n` +
                    "Respondé SOLO un JSON válido, sin texto alrededor, con esta forma exacta:\n" +
                    '{"corresponde": true|false, "legible": true|false, ' +
                    '"tipo_detectado": "texto corto", "numero": "solo dígitos o null", ' +
                    '"nombre": "nombre completo o null", "vencimiento": "YYYY-MM-DD o null", ' +
                    '"motivo": "una frase explicando la decisión"}\n' +
                    "Si la imagen no es un documento de identidad (por ejemplo un paisaje, " +
                    "una mascota, una captura de pantalla o una persona sin documento), " +
                    '"corresponde" debe ser false.',
                },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 400,
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Groq document review error ${res.status}`);
        return {
          matches: null,
          reason: "La revisión automática no está disponible.",
        };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);

      if (!parsed) {
        return {
          matches: null,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Groq document review exception: ${message}`);
      return {
        matches: null,
        reason: "La revisión automática no está disponible.",
      };
    }
  }

  async vision(imageDataUrl: string): Promise<{ isVehicle: boolean | null }> {
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
                { type: "image_url", image_url: { url: imageDataUrl } },
                {
                  type: "text",
                  text: "¿Esta imagen muestra un automóvil, camioneta, SUV, moto u otro vehículo de motor? Respondé únicamente SI o NO.",
                },
              ],
            },
          ],
          temperature: 0,
          max_tokens: 5,
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Groq vision error ${res.status}`);
        return { isVehicle: null };
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const answer = (data.choices?.[0]?.message?.content || "")
        .trim()
        .toUpperCase();
      return {
        isVehicle: answer.startsWith("SI")
          ? true
          : answer.startsWith("NO")
            ? false
            : null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Groq vision exception: ${message}`);
      return { isVehicle: null };
    }
  }
}
