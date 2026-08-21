import { Injectable, Logger } from "@nestjs/common";
import type {
  DocumentInspection,
  DocumentKind,
  SupportedLang,
} from "../../ai/ai.service";
import { BarcodeDecoderService } from "./barcode-decoder.service";
import { parseDniPdf417 } from "./dni-pdf417.parser";
import { parseLicenseCode } from "./license-code.parser";

/**
 * Tope de la imagen a decodificar. El DTO ya limita el string a 3 MB; esto es
 * el cinturón por si ese límite cambia: decodificar es trabajo de CPU y esto
 * corre dentro del request.
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Textos de las conclusiones que saca ESTE servicio (no las escribe el modelo). */
const RESULT: Record<
  SupportedLang,
  { dniCode: string; licenseCode: string; isDni: string }
> = {
  es: {
    dniCode: "Se leyó el código PDF417 del DNI: la foto sirve.",
    licenseCode: "Se leyó el código del dorso de la licencia: la foto sirve.",
    isDni: "Esta foto es el DNI, no la licencia de conducir.",
  },
  en: {
    dniCode: "The DNI's PDF417 code was read: the photo works.",
    licenseCode:
      "The code on the back of the licence was read: the photo works.",
    isDni: "This photo is the ID card, not the driving licence.",
  },
  pt: {
    dniCode: "O código PDF417 do DNI foi lido: a foto serve.",
    licenseCode: "O código do verso da habilitação foi lido: a foto serve.",
    isDni: "Esta foto é o DNI, não a habilitação.",
  },
  it: {
    dniCode: "Il codice PDF417 del DNI è stato letto: la foto va bene.",
    licenseCode:
      "Il codice sul retro della patente è stato letto: la foto va bene.",
    isDni: "Questa foto è il DNI, non la patente.",
  },
  zh: {
    dniCode: "已读取身份证的 PDF417 条码：照片可用。",
    licenseCode: "已读取驾照背面的条码：照片可用。",
    isDni: "这张照片是身份证，不是驾照。",
  },
};

/**
 * Convierte un dataURL de imagen a bytes.
 *
 * SOLO dataURL a propósito: si acá se aceptara una URL cualquiera, el servidor
 * saldría a descargar lo que le diga el cliente (SSRF). El front manda la foto
 * en base64 justamente porque revisa ANTES de subirla, así que no se pierde
 * nada; una URL remota simplemente cae en el camino con modelo.
 */
export function decodeImageDataUrl(image: string): Uint8Array | null {
  const match =
    /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      image.trim(),
    );
  if (!match) return null;

  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return new Uint8Array(bytes);
}

/**
 * Revisión de una foto de documento SIN modelo de IA: decodifica los códigos
 * impresos y saca conclusiones de lo que dicen.
 *
 * POR QUÉ EXISTE: el chequeo de cada foto se lo hacía enteramente a un modelo
 * de visión de Groq, así que cuando ese modelo fallaba —o contestaba algo que
 * no era el JSON pedido— la pantalla decía "no se pudo interpretar la revisión
 * automática" con cualquier imagen, y no había forma de avanzar. El PDF417 del
 * DNI lo imprime el RENAPER y lo lee un decodificador determinístico: si ese
 * código está y dice lo que tiene que decir, la foto es un DNI. Punto. No hace
 * falta preguntarle a nadie.
 *
 * Devuelve null cuando no puede concluir nada por sí solo (no hay código
 * legible en la foto): ahí sí se cae al modelo, que es el camino de siempre.
 */
@Injectable()
export class DocumentPrecheckService {
  private readonly logger = new Logger(DocumentPrecheckService.name);

  constructor(private readonly barcodes: BarcodeDecoderService) {}

  async check(
    image: string,
    kind: DocumentKind,
    lang: SupportedLang = "es",
  ): Promise<DocumentInspection | null> {
    const bytes = decodeImageDataUrl(image);
    if (!bytes) return null;

    let decoded: string[];
    try {
      decoded = (await this.barcodes.decode(bytes, ["PDF417", "QRCode"])).map(
        (result) => result.text,
      );
    } catch (error) {
      // decode() ya no lanza, pero si algún día lo hiciera, esto es un paso
      // OPCIONAL: nunca puede tumbar la revisión.
      this.logger.warn(
        `No se pudo decodificar la foto: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    if (decoded.length === 0) return null;

    // El PDF417 del RENAPER: prueba que la foto es de un DNI. No dice de qué
    // lado (según el ejemplar el código está en el frente o en el dorso), así
    // que sirve para los dos slots del DNI y para descartar los de la licencia.
    const dni = decoded.map(parseDniPdf417).find(Boolean);

    if (dni) {
      return kind === "DNI_FRONT" || kind === "DNI_BACK"
        ? {
            matches: true,
            reason: RESULT[lang].dniCode,
            detectedType: "DNI",
            documentNumber: dni.dni,
            fullName: `${dni.lastName} ${dni.firstName}`.trim(),
            expiresAt: null,
          }
        : {
            matches: false,
            reason: RESULT[lang].isDni,
            detectedType: "DNI",
          };
    }

    if (kind === "LICENSE_BACK" || kind === "LICENSE_FRONT") {
      const license = decoded.map(parseLicenseCode).find((code) => code.parsed);
      if (license) {
        return {
          matches: true,
          reason: RESULT[lang].licenseCode,
          detectedType: "licencia de conducir",
          documentNumber: license.dni,
          fullName: null,
          expiresAt: license.expiryDate,
        };
      }
    }

    return null;
  }
}
