import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  findJsonObject,
  stripReasoning,
} from "../common/utils/json-from-text.util";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";
const MODEL = "llama-3.3-70b-versatile";
const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

/**
 * Modelos de visión, en orden de preferencia.
 *
 * POR QUÉ ES UNA LISTA Y NO UNO SOLO: Groq da de baja modelos seguido, y cuando
 * eso pasa la llamada vuelve con un error de "modelo inexistente". Antes había un
 * único nombre escrito acá, así que el día que Groq lo retiró la revisión de
 * documentos dejó de funcionar entera: la pantalla decía "no se pudo revisar" y
 * el DNI se subía sin revisar, que es como una foto de un perro llegó a pasar por
 * documento.
 *
 * Ahora se prueban en orden hasta que uno contesta. Y si el error NO es por el
 * modelo (clave inválida, imagen demasiado grande), se corta enseguida: reintentar
 * con otro modelo no arregla nada y solo hace esperar a la persona.
 *
 * Con GROQ_VISION_MODEL se puede forzar uno (o varios separados por coma) sin
 * tocar el código, para el día que Groq saque un modelo nuevo.
 */
const DEFAULT_VISION_MODELS = [
  // Groq dio de baja los dos modelos llama-4 en junio de 2026 y recomienda pasar
  // a qwen3.6, que también acepta imágenes. Por eso va primero: con los llama-4
  // solos, la revisión de fotos quedó sin ningún modelo vivo y el panel de
  // administración avisaba "ninguno de los modelos configurados existe hoy".
  // Igual queda el respaldo de abajo, y GROQ_VISION_MODEL manda sobre todo esto:
  // el botón "Probar los modelos" del panel dice cuáles contestan HOY.
  "qwen/qwen3.6-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];

/**
 * Códigos con los que no tiene sentido probar otro modelo: son de la clave o
 * de la cuenta (sin autorización, sin crédito, sin cuota), así que todos los
 * modelos van a contestar lo mismo.
 */
const FATAL_STATUS = new Set([401, 402, 403, 429]);

/** Errores de Groq que significan "ese modelo ya no existe": probar el siguiente. */
const MODEL_GONE = /model_not_found|decommission|does not exist|not found/i;

/**
 * Errores de Groq que significan "ese modelo no acepta estos parámetros": se
 * repite el pedido sin ellos en vez de dar la revisión por perdida.
 */
const UNSUPPORTED_PARAM =
  /response_format|json_object|json mode|json_validate|reasoning_format/i;

/**
 * Un 400 que se queja de la IMAGEN y no del modelo, de la clave ni de la cuota.
 * Sirve para no dar por roto algo que está bien: ver probeVisionModel().
 */
const IMAGE_COMPLAINT =
  /image|imagen|pixel|dimension|resolution|too small|width|height/i;

/**
 * Imagen para probar si un modelo acepta pedidos con foto: PNG de 64x64 opaco,
 * con dos rectángulos. Generada una vez y pegada acá para no depender de nada.
 */
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABQklEQVR4AeyUsQ2DUAxELSagZQR2YBJWYR9K9mAIBAtQUyZyh9xwUihi3yFZ4ivWl+/5keZD/jRG/ggAuQAmA2QAOQF9AuQCYH+C27bZPM+pymdGlgt9Auu62jRNqcpnfg0AclHWHsiArOGQuQUAoVS5h86AuEwBiETYzjKAbeMxrwyIRNjOMoBt4zGvDIhE2M4ygG3jMa8MiETYzjKg+saf8kEGjONo+76nKp/5Kbz/DgHwxqolAMhmj+OwZVlSlc+MZIMMuK7LzvNMVT7zawCQi7L2QAZkDYfMLQAIpco9MqDydpFsMgChVLlHBlTeLpKtnAFI6HuPANxpML7LAMat3zPLgDsNxnfIgK7rbBiGVOUzIwuFALRta33fpyqf+TUAyEVZeyADsoZD5hYAhFLlHhlQebtINhmAUPrnnl9n+wIAAP//95dS9wAAAAZJREFUAwAfdSeuB4m6lgAAAABJRU5ErkJggg==";

/**
 * Tope de tokens de las respuestas que tienen que traer un JSON.
 *
 * Eran 400 y alcanzaban de sobra para el JSON pedido... hasta que el modelo de
 * turno pasó a ser uno de razonamiento: el análisis se comía el tope entero y
 * la respuesta llegaba cortada antes del JSON. Con `reasoning_format: hidden`
 * ese análisis ya no viaja en el contenido, pero igual consume tokens, así que
 * el tope queda holgado. Solo se paga lo que el modelo realmente escribe.
 */
const DOCUMENT_MAX_TOKENS = 1200;

// Tope del audio a transcribir (los mensajes de voz del chat son cortos).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** Documentos que sabe revisar inspectDocument(). */
export type DocumentKind =
  | "DNI_FRONT"
  | "DNI_BACK"
  | "LICENSE_FRONT"
  | "LICENSE_BACK";

/**
 * IDIOMA DE LAS RESPUESTAS DE LA IA
 *
 * El motivo por el que una foto no sirve ("parece un auto de juguete") lo escribe
 * el modelo y se le muestra tal cual a la persona. Con el prompt en castellano el
 * motivo volvía siempre en castellano, así que la app en inglés mostraba una
 * pantalla en inglés con la explicación en castellano: justo la parte que hace
 * falta entender para arreglar la foto.
 *
 * Ahora el front manda el idioma elegido y el prompt le pide al modelo que
 * escriba los campos de texto libre en ese idioma. Las preguntas del prompt
 * quedan en castellano a propósito: son instrucciones para el modelo, no texto
 * que alguien lea, y cambiarlas cambiaría los resultados de la revisión.
 */
export const SUPPORTED_LANGS = ["es", "en", "pt", "it", "zh"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

const LANG_NAME: Record<SupportedLang, string> = {
  es: "español",
  en: "inglés",
  pt: "portugués",
  it: "italiano",
  zh: "chino simplificado",
};

/** Le pide al modelo que escriba esos campos del JSON en el idioma elegido. */
const answerInLanguage = (lang: SupportedLang, fields: string[]): string =>
  `Escribí el contenido de ${fields.map((f) => `"${f}"`).join(" y ")} en ${LANG_NAME[lang]}. ` +
  "Las claves del JSON no se traducen: van tal cual están escritas acá.";

// Los textos que NO los escribe el modelo (fallos del servicio y respaldos).
const UNAVAILABLE: Record<
  SupportedLang,
  { notConfigured: string; unavailable: string; unreadable: string }
> = {
  es: {
    notConfigured: "La revisión automática no está configurada en el servidor.",
    unavailable: "La revisión automática no está disponible en este momento.",
    unreadable: "No se pudo interpretar la revisión automática.",
  },
  en: {
    notConfigured: "The automatic review is not configured on the server.",
    unavailable: "The automatic review is not available right now.",
    unreadable: "The automatic review could not be interpreted.",
  },
  pt: {
    notConfigured: "A revisão automática não está configurada no servidor.",
    unavailable: "A revisão automática não está disponível neste momento.",
    unreadable: "Não foi possível interpretar a revisão automática.",
  },
  it: {
    notConfigured: "Il controllo automatico non è configurato sul server.",
    unavailable: "Il controllo automatico non è disponibile in questo momento.",
    unreadable: "Non è stato possibile interpretare il controllo automatico.",
  },
  zh: {
    notConfigured: "服务器上尚未配置自动审核。",
    unavailable: "自动审核目前不可用。",
    unreadable: "无法解析自动审核的结果。",
  },
};

/** Qué texto de UNAVAILABLE le corresponde a cada motivo de fallo. */
const UNAVAILABLE_TEXT: Record<
  AiUnavailableCode,
  "notConfigured" | "unavailable" | "unreadable"
> = {
  not_configured: "notConfigured",
  upstream_error: "unavailable",
  unreadable: "unreadable",
};

const DOC_RESULT: Record<SupportedLang, { ok: string; bad: string }> = {
  es: {
    ok: "El documento coincide con lo esperado.",
    bad: "La imagen no corresponde al documento pedido.",
  },
  en: {
    ok: "The document matches what was expected.",
    bad: "The image is not the document that was asked for.",
  },
  pt: {
    ok: "O documento corresponde ao esperado.",
    bad: "A imagem não corresponde ao documento pedido.",
  },
  it: {
    ok: "Il documento corrisponde a quanto atteso.",
    bad: "L'immagine non corrisponde al documento richiesto.",
  },
  zh: { ok: "证件与要求相符。", bad: "图片不是要求的证件。" },
};

const VISION_RESULT: Record<
  SupportedLang,
  {
    notAVehicle: string;
    realCar: string;
    notReal: (detected: string | null) => string;
    notAVehicleSeen: (detected: string | null) => string;
  }
> = {
  es: {
    notAVehicle: "La imagen no muestra un vehículo.",
    realCar: "Es la foto de un vehículo real.",
    notReal: (d) =>
      `Parece ${d ?? "un vehículo de juguete o una imagen"}, no un vehículo real.`,
    notAVehicleSeen: (d) => `No es un vehículo${d ? `: se ve ${d}` : ""}.`,
  },
  en: {
    notAVehicle: "The image does not show a vehicle.",
    realCar: "This is a photo of a real vehicle.",
    notReal: (d) =>
      `It looks like ${d ?? "a toy vehicle or an image"}, not a real vehicle.`,
    notAVehicleSeen: (d) =>
      `This is not a vehicle${d ? `: it shows ${d}` : ""}.`,
  },
  pt: {
    notAVehicle: "A imagem não mostra um veículo.",
    realCar: "É a foto de um veículo real.",
    notReal: (d) =>
      `Parece ${d ?? "um veículo de brinquedo ou uma imagem"}, não um veículo real.`,
    notAVehicleSeen: (d) => `Não é um veículo${d ? `: aparece ${d}` : ""}.`,
  },
  it: {
    notAVehicle: "L'immagine non mostra un veicolo.",
    realCar: "È la foto di un veicolo vero.",
    notReal: (d) =>
      `Sembra ${d ?? "un veicolo giocattolo o un'immagine"}, non un veicolo vero.`,
    notAVehicleSeen: (d) => `Non è un veicolo${d ? `: si vede ${d}` : ""}.`,
  },
  zh: {
    notAVehicle: "图片中没有车辆。",
    realCar: "这是真实车辆的照片。",
    notReal: (d) => `看起来是${d ?? "玩具车或一张图片"}，不是真实车辆。`,
    notAVehicleSeen: (d) => `这不是车辆${d ? `：看到的是${d}` : ""}。`,
  },
};

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

/**
 * Lo que sale de una consulta al modelo de visión.
 *
 * El fallo trae el motivo CON el modelo que contestó y una muestra de lo que
 * dijo. Antes esa información existía pero se guardaba en un campo del
 * servicio (`lastVisionError`), o sea compartida entre todas las llamadas: con
 * cuatro fotos revisándose en paralelo, no había forma de saber cuál de las
 * cuatro había fallado ni por qué.
 */
export interface VisionAnswer {
  ok: true;
  content: string;
  /** El modelo que efectivamente contestó (puede no ser el primero). */
  model: string;
  durationMs: number;
}

export interface VisionFailure {
  ok: false;
  code: AiUnavailableCode;
  model: string | null;
  /** Recorte de lo que sí contestó, cuando contestó algo. */
  sample: string | null;
  durationMs: number;
  /** Todos los modelos que se probaron, en orden. */
  triedModels: string[];
  /**
   * Lo que contestó el proveedor cuando el fallo fue suyo: el código HTTP y el
   * cuerpo del error, que es donde dice qué hay que arreglar (clave sin cuota,
   * imagen demasiado grande, parámetro no soportado). Sin esto, el fallo
   * llegaba como "no contestó" y no había forma de saber por qué.
   */
  upstream?: { model: string; status?: number; detail: string };
}

/** Lo que contesta GET /ai/health. */
export interface AiHealthReport {
  configured: boolean;
  visionModels: string[];
  lastVisionError: string | null;
  /**
   * Recorte de la última respuesta que no se pudo interpretar. Solo se incluye
   * para administradores: el texto lo escribió el modelo mirando un documento.
   */
  lastVisionSample?: string | null;
  availableVisionModels?: string[];
  /** Resultado de probar cada modelo, solo cuando se pide con ?probe=1. */
  probed?: {
    model: string;
    ok: boolean;
    error?: string;
    testImageRejected?: boolean;
  }[];
  problem?: string;
  /** Aclaración cuando NO hay nada roto pero la prueba no fue concluyente. */
  note?: string;
}

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
  const candidate = findJsonObject(stripReasoning(text));
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
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

/** Recorte de una respuesta del proveedor, para poder mostrarla en una línea. */
function sampleOf(texto: string): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length > 300 ? `${limpio.slice(0, 300)}…` : limpio;
}

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

  /** Lo último que contestó Groq cuando falló, para poder mirarlo en /ai/health. */
  private lastVisionError: string | null = null;

  /**
   * Un recorte de la última respuesta que no se pudo interpretar. Es lo que
   * hace falta para distinguir "el modelo se puso a razonar y no llegó a
   * escribir el JSON" de "el modelo se negó a mirar un documento": desde afuera
   * las dos se veían igual. Solo se le muestra a un administrador (puede traer
   * texto del documento) y nunca se guarda en la base.
   */
  private lastVisionSample: string | null = null;

  /** Los modelos de visión a probar, en orden. GROQ_VISION_MODEL manda. */
  private visionModels(): string[] {
    const configured = (this.config.get<string>("GROQ_VISION_MODEL") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    // Los configurados primero, y los de siempre atrás como respaldo.
    return [...new Set([...configured, ...DEFAULT_VISION_MODELS])];
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
    options: { jsonMode?: boolean; requireJson?: boolean } = {},
  ): Promise<VisionAnswer | VisionFailure> {
    const started = Date.now();
    const triedModels: string[] = [];

    if (!this.configured) {
      this.logger.error(
        "Falta GROQ_API_KEY: la revisión por IA queda deshabilitada. " +
          "Cargala en las variables de entorno del backend.",
      );
      return {
        ok: false,
        code: "not_configured",
        model: null,
        sample: null,
        durationMs: Date.now() - started,
        triedModels,
      };
    }

    let contestoSinJson = false;
    let ultimaMuestra: string | null = null;
    let upstream: VisionFailure["upstream"];

    for (const model of this.visionModels()) {
      triedModels.push(model);
      const answer = await this.callVisionModel(
        model,
        imageUrl,
        prompt,
        maxTokens,
        options,
      );

      // El modelo ya no existe: el siguiente de la lista.
      if (answer.kind === "unusable_model") continue;

      if (answer.kind === "error") {
        upstream = { model, status: answer.status, detail: answer.detail };
        this.lastVisionSample = sampleOf(answer.detail);

        // Con la clave o la cuota no hay nada que hacer: le va a pasar lo
        // mismo a todos los modelos, y probarlos solo hace esperar de más.
        // Cualquier otro error puede ser de ESE modelo (no acepta el tamaño
        // de la imagen, no acepta un parámetro), así que se prueba el
        // siguiente: cortar en el primero dejaba sin usar los de respaldo.
        if (answer.status && FATAL_STATUS.has(answer.status)) {
          return {
            ok: false,
            code: "upstream_error",
            model,
            sample: this.lastVisionSample,
            durationMs: Date.now() - started,
            triedModels,
            upstream,
          };
        }
        continue;
      }

      if (!options.requireJson || findJsonObject(answer.content)) {
        this.lastVisionError = null;
        this.lastVisionSample = null;
        return {
          ok: true,
          content: answer.content,
          model,
          durationMs: Date.now() - started,
        };
      }

      // Contestó, pero no lo que se le pidió. Un modelo que no devuelve el JSON
      // es tan inservible como uno dado de baja, así que se prueba el siguiente
      // en vez de darle a la persona un "no se pudo interpretar" y listo. La
      // muestra de lo que sí contestó queda guardada: sin eso, esta falla es
      // invisible desde afuera (fue exactamente lo que pasó con qwen3, que
      // gastaba todo el tope de tokens razonando).
      contestoSinJson = true;
      this.lastVisionSample =
        answer.raw.slice(0, 300).replace(/\s+/g, " ").trim() ||
        "(respuesta vacía)";
      ultimaMuestra = this.lastVisionSample;
      this.lastVisionError =
        `${model} → contestó sin el JSON pedido` +
        (answer.truncated ? " (cortado por el tope de tokens)" : "");
      this.logger.error(
        `Groq visión (${model}) no devolvió JSON` +
          (answer.truncated ? " y la respuesta llegó cortada" : "") +
          `: ${this.lastVisionSample}`,
      );
    }

    const fallo = {
      model: triedModels[triedModels.length - 1] ?? null,
      sample: ultimaMuestra ?? this.lastVisionSample,
      durationMs: Date.now() - started,
      triedModels,
      ...(upstream ? { upstream } : {}),
    };

    if (contestoSinJson) return { ok: false, code: "unreadable", ...fallo };

    // Se agotó la lista: todos los modelos dieron "no existe".
    this.logger.error(
      "Ningún modelo de visión de la lista está disponible en Groq. " +
        "Mirá GET /ai/health para ver los que ofrece hoy y cargá uno en GROQ_VISION_MODEL.",
    );
    return { ok: false, code: "upstream_error", ...fallo };
  }

  /**
   * Una llamada a UN modelo, con la respuesta ya clasificada en qué hacer con
   * ella. Separada de askVisionModel() para que el bucle de modelos se lea de
   * corrido y para poder reintentar sin los parámetros extra.
   *
   * LOS PARÁMETROS EXTRA (`jsonMode`): `response_format` obliga al modelo a
   * devolver un objeto JSON y `reasoning_format: "hidden"` deja el razonamiento
   * de los modelos que piensan (qwen3, deepseek-r1) fuera del contenido, que es
   * lo que hacía llegar la respuesta cortada. No todos los modelos los
   * aceptan: si Groq contesta 400 quejándose de ellos, se repite el pedido sin
   * los extras antes de darlo por perdido.
   */
  private async callVisionModel(
    model: string,
    imageUrl: string,
    prompt: string,
    maxTokens: number,
    options: { jsonMode?: boolean },
    conExtras = options.jsonMode === true,
  ): Promise<
    | { kind: "content"; content: string; raw: string; truncated: boolean }
    | { kind: "unusable_model" }
    | { kind: "error"; status?: number; detail: string }
  > {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey()}`,
        },
        body: JSON.stringify({
          model,
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
          ...(conExtras
            ? {
                response_format: { type: "json_object" },
                reasoning_format: "hidden",
              }
            : {}),
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: {
            message?: { content?: string };
            finish_reason?: string;
          }[];
        };
        const choice = data.choices?.[0];
        const raw = choice?.message?.content ?? "";
        return {
          kind: "content",
          content: stripReasoning(raw),
          raw,
          // "length" = se acabó el tope de tokens antes de terminar de escribir.
          truncated: choice?.finish_reason === "length",
        };
      }

      // El cuerpo del error dice lo que hace falta para arreglarlo (clave
      // inválida, modelo dado de baja, imagen demasiado grande).
      const detail = (await res.text().catch(() => "")).slice(0, 500);

      if (conExtras && res.status === 400 && UNSUPPORTED_PARAM.test(detail)) {
        this.logger.warn(
          `Groq visión (${model}) no acepta response_format/reasoning_format: ` +
            "se repite el pedido sin esos parámetros.",
        );
        return this.callVisionModel(
          model,
          imageUrl,
          prompt,
          maxTokens,
          options,
          false,
        );
      }

      this.lastVisionError = `${model} → ${res.status}: ${detail}`;
      this.logger.error(
        `Groq visión (${model}) respondió ${res.status}: ${detail}`,
      );

      return res.status === 404 || MODEL_GONE.test(detail)
        ? { kind: "unusable_model" }
        : { kind: "error", status: res.status, detail };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastVisionError = `${model} → ${message}`;
      this.logger.error(`Groq visión (${model}) falló: ${message}`);
      return { kind: "error", detail: message };
    }
  }

  /**
   * Diagnóstico de la revisión por IA. Existe porque cuando esto se rompe, lo
   * único que se veía desde la app era un genérico "no se pudo revisar", y para
   * saber el motivo real había que entrar al panel del deploy a leer los logs
   * —que no siempre está a mano—. Acá se ve de una: si falta la clave, qué
   * contestó Groq la última vez, y qué modelos ofrece hoy.
   */
  /**
   * Prueba UN modelo de visión con una imagen mínima y dice si contesta.
   *
   * Existe porque `health()` solo comparaba nombres contra la lista de Groq, y
   * "estar en la lista" no es lo mismo que "funciona": un modelo puede estar
   * listado y contestar 400 porque no acepta imágenes, o 429 porque la clave se
   * quedó sin cuota. Con esto se ve qué modelo sirve HOY, que es lo que hace
   * falta para decidir qué poner en GROQ_VISION_MODEL.
   *
   * LA IMAGEN DE PRUEBA: un PNG de 64x64 con dos rectángulos.
   *
   * Antes era un PNG de 1x1 transparente, con la idea de que la respuesta no
   * importaba y solo se miraba si el modelo aceptaba el pedido. No sirve: qwen
   * contesta `400 invalid image data` a una imagen de un píxel, y el panel lo
   * mostraba como si el modelo estuviera roto. O sea que el aviso decía "la
   * revisión no funciona" justo cuando el modelo y la clave estaban perfectos.
   * 64x64 y opaca es una imagen que cualquier modelo de visión acepta.
   */
  private async probeVisionModel(model: string): Promise<{
    model: string;
    ok: boolean;
    error?: string;
    testImageRejected?: boolean;
  }> {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey()}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: PROBE_IMAGE } },
                { type: "text", text: "ok" },
              ],
            },
          ],
          max_tokens: 1,
        }),
      });
      if (res.ok) return { model, ok: true };
      const detalle = await res.text();
      // Un 400 que se queja de la IMAGEN no dice nada malo del modelo ni de la
      // clave: el pedido llegó, se autenticó y el modelo lo entendió. Se marca
      // aparte para no reportarlo como si la revisión estuviera rota.
      const testImageRejected =
        res.status === 400 && IMAGE_COMPLAINT.test(detalle);
      return {
        model,
        ok: false,
        error: `${res.status} ${detalle.slice(0, 180)}`,
        ...(testImageRejected ? { testImageRejected: true } : {}),
      };
    } catch (err) {
      return {
        model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * @param probe prueba cada modelo con una imagen (gasta cuota).
   * @param includeSample agrega un recorte de la última respuesta que no se
   *   pudo interpretar. Solo para administradores: puede traer texto del
   *   documento de alguien.
   */
  async health(probe = false, includeSample = false): Promise<AiHealthReport> {
    const report = await this.buildHealth(probe);
    return includeSample
      ? { ...report, lastVisionSample: this.lastVisionSample }
      : report;
  }

  private async buildHealth(probe: boolean): Promise<AiHealthReport> {
    const visionModels = this.visionModels();
    if (!this.configured) {
      return {
        configured: false,
        visionModels,
        lastVisionError: this.lastVisionError,
        problem:
          "Falta GROQ_API_KEY en las variables de entorno del backend. " +
          "Sin esa clave no se puede revisar ninguna foto.",
      };
    }

    try {
      const res = await fetch(MODELS_URL, {
        headers: { Authorization: `Bearer ${this.apiKey()}` },
      });
      if (!res.ok) {
        return {
          configured: true,
          visionModels,
          lastVisionError: this.lastVisionError,
          problem: `Groq respondió ${res.status} al pedirle la lista de modelos. Si es 401, la GROQ_API_KEY no sirve.`,
        };
      }
      const data = (await res.json()) as { data?: { id?: string }[] };
      const ids = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id));
      // Los que sirven para mirar imágenes: Groq no marca esto en la respuesta,
      // así que se filtra por nombre, que es lo que se puede hacer. `qwen` está
      // en la lista porque es el modelo multimodal al que Groq mandó a migrar
      // cuando dio de baja los llama-4; sin él, el panel no lo ofrecía como
      // alternativa aunque estuviera disponible.
      const withVision = ids.filter((id) =>
        /vision|llama-4|scout|maverick|qwen/i.test(id),
      );
      const usable = visionModels.filter((m) => ids.includes(m));

      // Se prueban los configurados y, si ninguno anda, también los que Groq
      // ofrece hoy: así el aviso puede decir cuál poner en vez de solo "ninguno
      // sirve". Se limita a seis para no gastar la cuota en una sola consulta.
      const probed = probe
        ? await Promise.all(
            [...new Set([...visionModels, ...withVision])]
              .slice(0, 6)
              .map((m) => this.probeVisionModel(m)),
          )
        : undefined;
      const funcionan = probed?.filter((p) => p.ok).map((p) => p.model) ?? [];
      // Los que rechazaron la imagen DE PRUEBA. No cuentan como roto: el pedido
      // llegó, la clave se aceptó y el modelo lo entendió, así que con una foto
      // de verdad puede andar perfectamente.
      const soloLaImagen =
        probed
          ?.filter((p) => !p.ok && p.testImageRejected)
          .map((p) => p.model) ?? [];

      return {
        configured: true,
        visionModels,
        lastVisionError: this.lastVisionError,
        availableVisionModels: withVision,
        probed,
        problem:
          usable.length === 0
            ? "Ninguno de los modelos configurados existe hoy en Groq. " +
              "Cargá uno de availableVisionModels en GROQ_VISION_MODEL."
            : probed && funcionan.length === 0 && soloLaImagen.length === 0
              ? "Los modelos configurados existen pero ninguno contestó. " +
                "Mirá el detalle en `probed`: si dice 401 la clave no sirve, y si " +
                "dice 429 se agotó la cuota de la clave."
              : undefined,
        note:
          probed && funcionan.length === 0 && soloLaImagen.length > 0
            ? `El modelo existe y la clave sirve: ${soloLaImagen.join(", ")} ` +
              "rechazó la imagen de prueba, no el pedido. Probalo con una foto " +
              "de verdad subiendo el DNI en la verificación de identidad."
            : undefined,
      };
    } catch (err) {
      return {
        configured: true,
        visionModels,
        lastVisionError: this.lastVisionError,
        problem: `No se pudo hablar con Groq: ${err instanceof Error ? err.message : String(err)}`,
      };
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
    lang: SupportedLang = "es",
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
        '"corresponde" debe ser false.\n' +
        answerInLanguage(lang, ["motivo", "tipo_detectado"]),
      DOCUMENT_MAX_TOKENS,
      { jsonMode: true, requireJson: true },
    );

    if (!answer.ok) {
      return {
        matches: null,
        code: answer.code,
        reason: UNAVAILABLE[lang][UNAVAILABLE_TEXT[answer.code]],
      };
    }

    const parsed = extractJson(answer.content);
    if (!parsed) {
      return {
        matches: null,
        code: "unreadable",
        reason: UNAVAILABLE[lang].unreadable,
      };
    }

    const matches = parsed.corresponde === true && parsed.legible !== false;
    return {
      matches,
      reason:
        typeof parsed.motivo === "string" && parsed.motivo
          ? parsed.motivo
          : matches
            ? DOC_RESULT[lang].ok
            : DOC_RESULT[lang].bad,
      detectedType: asText(parsed.tipo_detectado),
      documentNumber: asDigits(parsed.numero),
      fullName: asText(parsed.nombre),
      expiresAt: asDate(parsed.vencimiento),
    };
  }

  /**
   * Extracción estructurada libre sobre una imagen: mismo modelo de visión,
   * pero con el prompt que arme el llamador. La usa el OCR de documentos de la
   * verificación de identidad (modo document_ai), que necesita leer campos
   * concretos de cada lado del DNI y de la licencia.
   *
   * Devuelve el texto crudo del modelo (el llamador parsea el JSON) o null si
   * el proveedor no está disponible: ese null significa "fuente no
   * disponible", nunca un dato válido.
   */
  async visionStructured(
    imageDataUrl: string,
    prompt: string,
    maxTokens = DOCUMENT_MAX_TOKENS,
  ): Promise<string | null> {
    const answer = await this.visionStructuredDetailed(
      imageDataUrl,
      prompt,
      maxTokens,
    );
    return answer.ok ? answer.content : null;
  }

  /**
   * Igual que visionStructured pero devolviendo POR QUÉ falló, con qué modelo
   * y qué contestó. Es lo que necesita la lectura de documentos para poder
   * decir "esta foto no se pudo leer porque el modelo contestó tal cosa" en
   * vez de un `null` que no se puede diagnosticar.
   */
  visionStructuredDetailed(
    imageDataUrl: string,
    prompt: string,
    maxTokens = DOCUMENT_MAX_TOKENS,
  ): Promise<VisionAnswer | VisionFailure> {
    return this.askVisionModel(imageDataUrl, prompt, maxTokens, {
      jsonMode: true,
      requireJson: true,
    });
  }

  /**
   * ¿La foto muestra un vehículo REAL, de los que se pueden alquilar?
   *
   * Antes la pregunta era "¿esta imagen muestra un automóvil, camioneta, SUV,
   * moto u otro vehículo de motor? SI o NO". Con esa pregunta un auto de juguete
   * contesta SI —porque es, efectivamente, la imagen de un automóvil— y también
   * contestan SI un dibujo, una maqueta, una captura de un videojuego y el auto
   * de un afiche. O sea que el control existía pero no filtraba lo que hay que
   * filtrar: que la foto sea del auto de verdad que se está publicando.
   *
   * Ahora se pregunta por separado si es un vehículo Y si es uno real de tamaño
   * real, con la lista de casos a rechazar escrita explícitamente, y se pide el
   * motivo para poder mostrárselo a la persona en vez de un "no válido" pelado.
   *
   * `isVehicle` en null significa "no se pudo verificar", y `code` dice por qué:
   * así la pantalla puede avisar que falta configurar el servidor en vez de
   * quedarse en un silencioso "no verificada".
   */
  async vision(
    imageDataUrl: string,
    lang: SupportedLang = "es",
  ): Promise<{
    isVehicle: boolean | null;
    /** Qué se vio en la foto, para explicarle a la persona por qué no sirve. */
    reason?: string;
    detected?: string | null;
    code?: AiUnavailableCode;
  }> {
    const answer = await this.askVisionModel(
      imageDataUrl,
      "Mirá la imagen. Tiene que ser la foto de un vehículo REAL, de tamaño real, " +
        "de los que una persona puede conducir y alquilar (auto, camioneta, SUV, " +
        "pickup, van o moto).\n\n" +
        "RECHAZALA si es cualquiera de estas cosas, aunque tenga forma de auto:\n" +
        "- un juguete, un auto a escala, una maqueta o un auto a batería para chicos\n" +
        "- un dibujo, una ilustración, un render 3D o una captura de un videojuego\n" +
        "- la foto de un afiche, una pantalla, un catálogo o una publicidad\n" +
        "- un vehículo que no se alquila así (tren, avión, barco, bicicleta, monopatín)\n" +
        "- cualquier otra cosa (una persona, un animal, un paisaje, comida, una captura de pantalla)\n\n" +
        "Pistas para darte cuenta de que NO es real: proporciones de juguete, " +
        "plástico brillante, ruedas lisas sin dibujo, asiento de plástico, " +
        "tamaño chico comparado con lo que está alrededor, fondo de estudio blanco " +
        "tipo foto de producto, o que no tenga patente ni espejos ni picaportes reales.\n\n" +
        "Respondé SOLO un JSON válido, sin texto alrededor, con esta forma exacta:\n" +
        '{"es_vehiculo": true|false, "es_real": true|false, ' +
        '"que_es": "en 2 o 3 palabras qué se ve", ' +
        '"motivo": "una frase corta explicando la decisión"}\n' +
        answerInLanguage(lang, ["motivo", "que_es"]),
      // Mismo motivo que en la revisión de documentos: con un modelo de
      // razonamiento, 220 tokens se van enteros en el análisis y la respuesta
      // llega cortada antes del JSON. Acá no se exige el JSON (hay respaldo
      // SI/NO), pero el tope holgado evita la mayoría de esos casos.
      DOCUMENT_MAX_TOKENS,
      { jsonMode: true },
    );

    if (!answer.ok) return { isVehicle: null, code: answer.code };

    const parsed = extractJson(answer.content);
    if (!parsed) {
      // Respaldo para el modelo que contesta SI/NO en vez del JSON pedido. No
      // distingue un juguete, así que solo sirve para descartar lo evidente.
      const text = answer.content.trim().toUpperCase();
      if (text.startsWith("SI")) return { isVehicle: true };
      if (text.startsWith("NO")) {
        return { isVehicle: false, reason: VISION_RESULT[lang].notAVehicle };
      }
      return { isVehicle: null, code: "unreadable" };
    }

    const esVehiculo = parsed.es_vehiculo === true;
    // `es_real` solo cuenta como negativo si el modelo dijo false explícitamente:
    // si no contestó ese campo, no se rechaza una foto buena por un dato faltante.
    const esReal = parsed.es_real !== false;
    const detected = asText(parsed.que_es);
    const motivo = asText(parsed.motivo);

    if (esVehiculo && esReal) {
      return {
        isVehicle: true,
        reason: motivo ?? VISION_RESULT[lang].realCar,
        detected,
      };
    }

    return {
      isVehicle: false,
      reason:
        motivo ??
        (esVehiculo
          ? VISION_RESULT[lang].notReal(detected)
          : VISION_RESULT[lang].notAVehicleSeen(detected)),
      detected,
    };
  }
}
