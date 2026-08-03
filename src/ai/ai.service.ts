import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

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
   * Extracción estructurada sobre una imagen: mismo modelo multimodal que
   * `vision`, pero con prompt libre y temperatura 0 para que la salida sea
   * determinista. Devuelve el texto crudo del modelo (el caller parsea el
   * JSON) o null si el proveedor falla: quien llama debe tratar el null como
   * "fuente no disponible", nunca como un dato válido.
   */
  async visionStructured(
    imageDataUrl: string,
    prompt: string,
    maxTokens = 700,
  ): Promise<string | null> {
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
                { type: "text", text: prompt },
              ],
            },
          ],
          temperature: 0,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Groq vision error ${res.status}`);
        return null;
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Groq vision exception: ${message}`);
      return null;
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
