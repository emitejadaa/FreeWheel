import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { CloudinaryService } from "../../media/cloudinary.service";
import { DocumentSlot } from "../docverify/docverify.types";
import { SubmitDocumentDto } from "../dto/submit-document.dto";
import { UploadSignatureDto } from "../dto/upload-signature.dto";

/** Tipo de documento en minúscula, como viaja en las URLs y los public_id. */
export type DocumentKind = "dni" | "license";

const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

/** Carpeta reservada: solo este servicio firma subidas dentro de ella. */
export const IDENTITY_FOLDER_PREFIX = "identity";

export function identityFolder(userId: string): string {
  return `${IDENTITY_FOLDER_PREFIX}/${userId}`;
}

export function slotFor(
  kind: DocumentKind,
  side: "front" | "back",
): DocumentSlot {
  return `${kind}_${side}`;
}

interface ParsedAsset {
  publicId: string;
  format: string;
}

/**
 * Todo lo que rodea a los ARCHIVOS de identidad: firma de subida por slot,
 * validación de que cada URL enviada es realmente nuestra y corresponde al
 * slot en el que llegó, y borrado definitivo cuando una verificación se
 * rechaza o se reemplaza.
 *
 * Reglas de seguridad que implementa:
 * - carpeta y public_id los fija el servidor a partir del JWT, nunca el
 *   cliente → nadie puede subir a la carpeta de otro usuario;
 * - type=authenticated → los documentos no son legibles públicamente;
 * - el submit solo acepta URLs de nuestro cloud, bajo identity/<userId>/,
 *   con el prefijo de slot correcto y que existan de verdad en Cloudinary.
 */
@Injectable()
export class IdentityDocumentsService {
  private readonly logger = new Logger(IdentityDocumentsService.name);

  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Firma la subida de UN slot (documento + lado). El cliente hace POST
   * multipart a https://api.cloudinary.com/v1_1/<cloudName>/image/upload
   * con file, api_key y exactamente los params firmados que devolvemos.
   */
  signUpload(userId: string, dto: UploadSignatureDto) {
    const folder = identityFolder(userId);
    const slot = slotFor(dto.document, dto.side);
    const publicId = `${folder}/${slot}_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const timestamp = Math.round(Date.now() / 1000);

    const params = {
      folder,
      public_id: publicId,
      timestamp,
      type: "authenticated",
    };
    const { cloudName, apiKey, signature } =
      this.cloudinary.signUploadParams(params);

    return {
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      type: "authenticated" as const,
      document: dto.document,
      side: dto.side,
    };
  }

  /**
   * Valida las dos URLs de un documento (frente y dorso) y devuelve las
   * formas canónicas sin firma que se persisten. Una URL sin firma sobre un
   * asset authenticated es inerte: Cloudinary responde 401 a quien la tenga.
   */
  async validateSubmission(
    userId: string,
    kind: DocumentKind,
    dto: SubmitDocumentDto,
  ): Promise<{ frontUrl: string; backUrl: string }> {
    const parsed = [
      {
        slot: slotFor(kind, "front"),
        asset: this.parseIdentityUrl(
          userId,
          slotFor(kind, "front"),
          dto.frontUrl,
        ),
      },
      {
        slot: slotFor(kind, "back"),
        asset: this.parseIdentityUrl(
          userId,
          slotFor(kind, "back"),
          dto.backUrl,
        ),
      },
    ];

    const existence = await Promise.all(
      parsed.map(({ asset }) => this.cloudinary.resourceExists(asset.publicId)),
    );
    parsed.forEach(({ slot }, index) => {
      if (!existence[index]) {
        throw new BadRequestException({
          statusCode: 400,
          code: "DOCUMENT_NOT_FOUND",
          message: "El archivo no existe en el almacenamiento",
          slot,
        });
      }
    });

    return {
      frontUrl: this.canonicalUrl(parsed[0].asset),
      backUrl: this.canonicalUrl(parsed[1].asset),
    };
  }

  /** Descarga los bytes de un documento ya persistido, acotados en tamaño. */
  download(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const asset = this.parsePersistedUrl(url);
    if (!asset) {
      throw new BadRequestException("URL de documento inválida");
    }
    // Acotada por Cloudinary al entregar: suficiente para leer códigos y
    // texto, sin cargar fotos de decenas de MB en memoria.
    return this.cloudinary.download(asset.publicId, {
      transformation: "c_limit,w_2000,q_auto:best",
      format: "jpg",
    });
  }

  /**
   * Borra del storage los archivos de una verificación (rechazo de un
   * admin, o reemplazo por un reenvío). Best-effort registrado: si un
   * borrado falla queda en el log — preferimos completar el flujo antes
   * que dejar al usuario trabado por un fallo de infraestructura.
   */
  async deleteDocuments(urls: (string | null)[]): Promise<void> {
    for (const url of urls) {
      if (!url) continue;
      const asset = this.parsePersistedUrl(url);
      if (!asset) continue;
      try {
        await this.cloudinary.destroy(asset.publicId);
      } catch (error) {
        this.logger.error(
          `No se pudo borrar ${asset.publicId} del storage: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /** publicId + formato desde una URL canónica ya persistida. */
  parsePersistedUrl(url: string): ParsedAsset | null {
    const match = new RegExp(
      `^https://res\\.cloudinary\\.com/${this.escapeRegex(this.cloudinary.getCloudName())}` +
        `/image/authenticated/(?:s--[A-Za-z0-9_-]+--/)?(?:v\\d+/)?(.+)\\.([A-Za-z0-9]+)$`,
    ).exec(url);
    if (!match) return null;

    return { publicId: match[1], format: match[2].toLowerCase() };
  }

  private parseIdentityUrl(
    userId: string,
    slot: DocumentSlot,
    url: string,
  ): ParsedAsset {
    const asset = this.parsePersistedUrl(url);
    if (!asset || !ALLOWED_FORMATS.includes(asset.format)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_DOCUMENT_URL",
        message:
          "La URL no corresponde a un documento subido con la firma de este endpoint",
        slot,
      });
    }

    // El public_id lleva la carpeta del dueño y el slot: un archivo del slot
    // equivocado (o de otra cuenta) no puede colarse por otro campo.
    const expectedPrefix = `${identityFolder(userId)}/${slot}_`;
    if (!asset.publicId.startsWith(expectedPrefix)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DOCUMENT_SLOT_MISMATCH",
        message:
          "El archivo enviado no corresponde a este documento/lado o a esta cuenta",
        slot,
      });
    }

    return asset;
  }

  private canonicalUrl(asset: ParsedAsset): string {
    return (
      `https://res.cloudinary.com/${this.cloudinary.getCloudName()}` +
      `/image/authenticated/${asset.publicId}.${asset.format}`
    );
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
