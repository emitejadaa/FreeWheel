import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import {
  ParseResult,
  describeError,
  parseFail,
  verificationError,
} from "../errors/verification-errors";
import { DocumentSlot, OcrExtraction } from "./extraction.types";
import { buildOcrPrompt } from "./ocr/ocr-prompt";
import { parseOcrResponse, toOcrExtraction } from "./ocr/ocr-response.parser";
import { OcrDocumentRead } from "./ocr/ocr.types";

/**
 * Tope de tokens de la respuesta, por lado.
 *
 * No es un número al azar: cuando la respuesta no entra, el modelo la corta a
 * la mitad, el JSON queda sin cerrar y la lectura se pierde entera. El dorso
 * del DNI es el caso más pesado (domicilio + CUIL + las tres líneas del MRZ +
 * el texto completo), y el dorso de la licencia el más liviano.
 */
const MAX_TOKENS: Record<DocumentSlot, number> = {
  dni_front: 1400,
  dni_back: 2200,
  license_front: 1400,
  license_back: 900,
};

/** Pedir las posiciones alarga la respuesta: hay que darle lugar. */
const BOX_ALLOWANCE = 1.6;

/**
 * Tope de la imagen que se le manda al modelo.
 *
 * Groq acepta hasta 4 MB por imagen cuando viaja en base64, y pasarse no da un
 * error que se entienda: contesta un 400 genérico y desde afuera se ve igual
 * que "el modelo no anda". En la revisión real esto nunca pasa porque las
 * fotos se bajan ya achicadas de Cloudinary; en el diagnóstico, en cambio, la
 * foto va tal cual la eligió la persona, y una del celular se pasa fácil.
 */
const MAX_VISION_BYTES = 4 * 1024 * 1024;

/**
 * MÓDULO 1 · lectura del texto impreso con el modelo de visión.
 *
 * Lo que el modelo hace acá es UNA sola cosa: mirar una foto y decir qué dice,
 * dato por dato. No compara contra el formulario, no compara contra el código
 * de barras, no valida nada. Todo eso pasa después, en código, donde se puede
 * testear y donde queda registrado por qué se decidió lo que se decidió.
 *
 * Es también la parte prescindible del pipeline: es la única que depende de un
 * proveedor externo. Si no contesta, la verificación sigue en pie con el
 * PDF417 y los datos de la cuenta; lo que se pierde es la corroboración.
 */
@Injectable()
export class DocumentOcrService {
  private readonly logger = new Logger(DocumentOcrService.name);

  constructor(private readonly ai: AiService) {}

  /**
   * La lectura completa, con evidencia y con el motivo cuando no se pudo.
   * `withBoxes` pide además dónde está cada dato en la foto: solo lo usa el
   * diagnóstico, porque alarga la respuesta y no cambia ningún veredicto.
   */
  async read(
    slot: DocumentSlot,
    imageBytes: Uint8Array,
    mimeType = "image/jpeg",
    options: { withBoxes?: boolean } = {},
  ): Promise<ParseResult<OcrDocumentRead>> {
    if (imageBytes.length === 0) {
      return parseFail(verificationError("IMAGE_EMPTY", { slot }));
    }

    // El modelo recibe la imagen que ya descargamos, no una URL: así ningún
    // tercero necesita acceso a los documentos del usuario.
    const dataUrl = `data:${mimeType};base64,${Buffer.from(imageBytes).toString("base64")}`;

    // Se corta ACÁ, con un mensaje que dice qué pasa, en vez de dejar que el
    // proveedor conteste un 400 que no explica nada.
    if (dataUrl.length > MAX_VISION_BYTES) {
      return parseFail(
        verificationError(
          "IMAGE_TOO_LARGE",
          { bytes: dataUrl.length, limit: MAX_VISION_BYTES },
          "el tope lo pone el proveedor de visión para las imágenes en base64",
        ),
      );
    }
    const maxTokens = Math.round(
      MAX_TOKENS[slot] * (options.withBoxes ? BOX_ALLOWANCE : 1),
    );

    const answer = await this.ai.visionStructuredDetailed(
      dataUrl,
      buildOcrPrompt(slot, options),
      maxTokens,
    );

    if (!answer.ok) {
      if (answer.code === "not_configured") {
        return parseFail(verificationError("OCR_NOT_CONFIGURED"));
      }

      const probados = `modelos probados: ${answer.triedModels.join(", ")}`;

      if (answer.code === "unreadable") {
        return parseFail(
          verificationError(
            "OCR_RESPONSE_NOT_JSON",
            { slot, sample: answer.sample ?? undefined },
            probados,
          ),
        );
      }

      // Lo que contestó el proveedor viaja tal cual: es la única forma de
      // distinguir "la clave se quedó sin cuota" de "la imagen es muy grande"
      // de "ese modelo no existe más", que se arreglan de maneras distintas.
      const upstream = answer.upstream;
      return parseFail(
        verificationError(
          "OCR_MODEL_UNAVAILABLE",
          {
            slot,
            cause: upstream
              ? `${upstream.model} respondió ${upstream.status ?? "sin código"}`
              : `no contestó ninguno de ${answer.triedModels.length} modelos`,
          },
          upstream ? `${upstream.detail} · ${probados}` : probados,
        ),
      );
    }

    return parseOcrResponse(slot, answer.content, {
      model: answer.model,
      durationMs: answer.durationMs,
    });
  }

  /**
   * La misma lectura, proyectada al formato plano que consume el cruce.
   *
   * Se mantiene porque es lo que ya usan la revisión y los tests: `read()` es
   * el primitivo nuevo y esto es su proyección. Nunca lanza: ante cualquier
   * problema devuelve null —el cruce lo trata como fuente no disponible— y
   * deja el motivo en el log del servidor.
   */
  async extract(
    slot: DocumentSlot,
    imageBytes: Uint8Array,
    mimeType = "image/jpeg",
  ): Promise<OcrExtraction | null> {
    const read = await this.read(slot, imageBytes, mimeType);

    if (!read.ok) {
      this.logger.warn(`OCR de ${slot}: ${describeError(read.error)}`);
      return null;
    }
    for (const warning of read.data.warnings) {
      this.logger.debug(`OCR de ${slot}: ${describeError(warning)}`);
    }

    return toOcrExtraction(read.data);
  }
}
