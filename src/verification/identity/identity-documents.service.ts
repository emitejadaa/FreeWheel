import { BadRequestException, Injectable } from "@nestjs/common";
import { UserVerification, VerificationStatus } from "@prisma/client";
import { randomBytes } from "crypto";
import { CloudinaryService } from "../../media/cloudinary.service";
import { SubmitIdentityDto } from "../dto/submit-identity.dto";
import { UploadSignatureDto } from "../dto/upload-signature.dto";

/** Slot = documento + lado. Un slot por columna de UserVerification. */
export const IDENTITY_SLOTS = [
  "dni_front",
  "dni_back",
  "license_front",
  "license_back",
] as const;

export type IdentitySlot = (typeof IDENTITY_SLOTS)[number];

/** Campo del DTO/columna ↔ slot que debe contener. */
export const SLOT_BY_FIELD: Record<
  "dniFrontUrl" | "dniBackUrl" | "licenseFrontUrl" | "licenseBackUrl",
  IdentitySlot
> = {
  dniFrontUrl: "dni_front",
  dniBackUrl: "dni_back",
  licenseFrontUrl: "license_front",
  licenseBackUrl: "license_back",
};

const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

/** Carpeta reservada: solo este servicio firma subidas dentro de ella. */
export const IDENTITY_FOLDER_PREFIX = "identity";

export function identityFolder(userId: string): string {
  return `${IDENTITY_FOLDER_PREFIX}/${userId}`;
}

export interface IdentitySubmissionView {
  id: string;
  status: VerificationStatus;
  createdAt: Date;
  reviewedAt: Date | null;
  reasonCodes: string[];
  documents: {
    dniFront: boolean;
    dniBack: boolean;
    licenseFront: boolean;
    licenseBack: boolean;
  };
}

interface ParsedAsset {
  publicId: string;
  format: string;
}

/**
 * Todo lo que rodea a los archivos de identidad: firma de subida por slot,
 * validación de que cada URL enviada es realmente nuestra y corresponde al
 * slot en el que llegó, y proyección sanitizada para el usuario.
 *
 * Reglas de seguridad que implementa:
 * - carpeta y public_id los fija el servidor a partir del JWT, nunca el
 *   cliente → nadie puede subir a la carpeta de otro usuario;
 * - type=authenticated → los documentos no son legibles públicamente;
 * - el submit solo acepta URLs de nuestro cloud, bajo identity/<userId>/, con
 *   el prefijo de slot correcto y que existan de verdad en Cloudinary.
 */
@Injectable()
export class IdentityDocumentsService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Firma la subida de UN slot. El cliente hace POST multipart a
   * https://api.cloudinary.com/v1_1/<cloudName>/image/upload con file,
   * api_key y exactamente los params firmados que devolvemos.
   */
  signUpload(userId: string, dto: UploadSignatureDto) {
    // La selfie no tiene lado; los documentos sí, y sin él no habría slot que
    // atar al archivo (que es lo que impide confundir frente con dorso).
    if (dto.document === "selfie") {
      if (dto.side) {
        throw new BadRequestException("La selfie no lleva lado");
      }
    } else if (!dto.side) {
      throw new BadRequestException(
        'Falta "side" ("front" o "back") para este documento',
      );
    }

    const folder = identityFolder(userId);
    const slot = dto.side ? `${dto.document}_${dto.side}` : dto.document;
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
   * Valida las cuatro URLs (y la selfie si vino) y devuelve las URLs
   * canónicas sin firma que se persisten. Una URL sin firma sobre un asset
   * authenticated es inerte: Cloudinary responde 401 a quien la tenga.
   */
  async validateSubmission(
    userId: string,
    dto: SubmitIdentityDto,
  ): Promise<
    Record<keyof typeof SLOT_BY_FIELD, string> & { selfieUrl?: string }
  > {
    const entries = Object.entries(SLOT_BY_FIELD) as [
      keyof typeof SLOT_BY_FIELD,
      IdentitySlot,
    ][];

    const parsed = entries.map(([field, slot]) => ({
      field: field as keyof typeof SLOT_BY_FIELD | "selfieUrl",
      slot: slot as IdentitySlot | "selfie",
      asset: this.parseIdentityUrl(userId, slot, dto[field]),
    }));

    // La selfie es opcional, pero si viene se valida igual que un documento:
    // una URL arbitraria guardada acá la termina abriendo un admin.
    if (dto.selfieUrl) {
      parsed.push({
        field: "selfieUrl",
        slot: "selfie",
        asset: this.parseIdentityUrl(userId, "selfie", dto.selfieUrl),
      });
    }

    // Existencia en paralelo: cuatro llamadas independientes a la Admin API.
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

    return Object.fromEntries(
      parsed.map(({ field, asset }) => [field, this.canonicalUrl(asset)]),
    ) as Record<keyof typeof SLOT_BY_FIELD, string> & { selfieUrl?: string };
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

  /** Proyección segura: sin URLs, sin notas internas, sin datos extraídos. */
  toPublicView(submission: UserVerification): IdentitySubmissionView {
    return {
      id: submission.id,
      status: submission.status,
      createdAt: submission.createdAt,
      reviewedAt: submission.reviewedAt,
      reasonCodes: readReasonCodes(submission.matchReport),
      documents: {
        dniFront: Boolean(submission.dniFrontUrl),
        dniBack: Boolean(submission.dniBackUrl),
        licenseFront: Boolean(submission.licenseFrontUrl),
        licenseBack: Boolean(submission.licenseBackUrl),
      },
    };
  }

  private parseIdentityUrl(
    userId: string,
    slot: IdentitySlot | "selfie",
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

/** reasonCodes del matchReport (JSON) tolerando filas viejas o vacías. */
export function readReasonCodes(matchReport: unknown): string[] {
  if (
    matchReport &&
    typeof matchReport === "object" &&
    Array.isArray((matchReport as { reasonCodes?: unknown }).reasonCodes)
  ) {
    return (matchReport as { reasonCodes: unknown[] }).reasonCodes.filter(
      (code): code is string => typeof code === "string",
    );
  }
  return [];
}
