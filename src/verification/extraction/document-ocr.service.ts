import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { DocumentSlot, OcrExtraction, OcrFields } from "./extraction.types";

/** Qué se le pide leer al modelo en cada lado del documento. */
const SLOT_INSTRUCTIONS: Record<DocumentSlot, string> = {
  dni_front:
    'Campos del FRENTE del DNI argentino: "apellido", "nombre", "sexo" (M o F), ' +
    '"nroDocumento" (solo dígitos), "fechaNacimiento" y "fechaVencimiento" (DD/MM/AAAA).',
  dni_back:
    'Campos del DORSO del DNI argentino: "domicilio" (calle, número, localidad), ' +
    '"cuil" (11 dígitos) si está impreso, y "mrzLines": un array con las 3 líneas ' +
    "de 30 caracteres de la zona legible por máquina del pie, transcriptas EXACTAMENTE " +
    "carácter por carácter incluyendo los signos <.",
  license_front:
    'Campos del FRENTE de la licencia de conducir argentina: "apellido", "nombre", ' +
    '"nroDocumento" (el DNI, solo dígitos), "domicilio", "fechaNacimiento" y ' +
    '"fechaVencimiento" (DD/MM/AAAA; si hay varias clases con vencimientos distintos, ' +
    "usá el más próximo).",
  license_back:
    'Campos del DORSO de la licencia de conducir argentina: "fechaVencimiento" si está ' +
    "impreso. Este lado suele traer solo un código QR.",
};

const SLOT_LABELS: Record<DocumentSlot, string> = {
  dni_front: "frente del DNI",
  dni_back: "dorso del DNI",
  license_front: "frente de la licencia de conducir",
  license_back: "dorso de la licencia de conducir",
};

function buildPrompt(slot: DocumentSlot): string {
  return [
    `Analizá esta foto. Se espera que sea el ${SLOT_LABELS[slot]} de un documento argentino.`,
    "",
    "Respondé ÚNICAMENTE con un objeto JSON, sin texto alrededor ni ```:",
    '{"classifiedAs": "dni_front"|"dni_back"|"license_front"|"license_back"|"unknown", "fields": {...}}',
    "",
    '"classifiedAs" es qué documento y lado ves REALMENTE en la imagen (no lo que se espera).',
    'Usá "unknown" si la imagen está ilegible o no es ninguno de esos documentos.',
    "",
    SLOT_INSTRUCTIONS[slot],
    "",
    "Reglas: omití por completo los campos que no puedas leer con certeza.",
    "No inventes ni completes datos. Transcribí exactamente lo impreso.",
  ].join("\n");
}

/** Extrae el primer objeto JSON del texto, tolerando ``` y texto alrededor. */
export function parseOcrJson(raw: string): OcrExtraction | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const record = data as Record<string, unknown>;
  const classifiedAs = normalizeClassification(record.classifiedAs);
  const fields = normalizeFields(record.fields);

  return { classifiedAs, fields };
}

function normalizeClassification(
  value: unknown,
): OcrExtraction["classifiedAs"] {
  const slots: DocumentSlot[] = [
    "dni_front",
    "dni_back",
    "license_front",
    "license_back",
  ];
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return (slots as string[]).includes(normalized)
    ? (normalized as DocumentSlot)
    : "unknown";
}

/** Solo campos conocidos, solo strings no vacíos: nada de basura del modelo. */
function normalizeFields(value: unknown): OcrFields {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const fields: OcrFields = {};

  const textKeys = [
    "apellido",
    "nombre",
    "sexo",
    "nroDocumento",
    "fechaNacimiento",
    "fechaVencimiento",
    "domicilio",
    "cuil",
  ] as const;

  for (const key of textKeys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      fields[key] = raw.trim();
    } else if (typeof raw === "number") {
      fields[key] = String(raw);
    }
  }

  if (Array.isArray(record.mrzLines)) {
    const lines = record.mrzLines.filter(
      (line): line is string => typeof line === "string",
    );
    if (lines.length > 0) fields.mrzLines = lines;
  }

  return fields;
}

/**
 * Lectura del texto impreso de cada documento con el modelo multimodal ya
 * integrado (Groq). Es la fuente MENOS confiable del pipeline —la escribe un
 * modelo probabilístico—, por eso su salida solo aporta datos que después se
 * cruzan contra anclas determinísticas (PDF417, MRZ con dígitos
 * verificadores, checksum del CUIL). Nunca lanza: ante cualquier problema
 * devuelve null y el cruce lo trata como fuente no disponible.
 */
@Injectable()
export class DocumentOcrService {
  private readonly logger = new Logger(DocumentOcrService.name);

  constructor(private readonly ai: AiService) {}

  async extract(
    slot: DocumentSlot,
    imageBytes: Uint8Array,
    mimeType = "image/jpeg",
  ): Promise<OcrExtraction | null> {
    if (imageBytes.length === 0) return null;

    // El modelo recibe la imagen que ya descargamos, no una URL: así ningún
    // tercero necesita acceso a los documentos del usuario.
    const dataUrl = `data:${mimeType};base64,${Buffer.from(imageBytes).toString("base64")}`;

    const raw = await this.ai.visionStructured(dataUrl, buildPrompt(slot));
    if (!raw) return null;

    const parsed = parseOcrJson(raw);
    if (!parsed) {
      this.logger.warn(`OCR devolvió una respuesta no parseable para ${slot}`);
      return null;
    }
    return parsed;
  }
}
