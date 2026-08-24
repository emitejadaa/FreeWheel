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

/** Campo del body al que pertenece cada archivo. */
export type DocumentField = "frontUrl" | "backUrl";

/**
 * Causa exacta por la que una URL no sirve. Es el dato que hacía falta para
 * poder arreglar el problema sin adivinar: el `code` HTTP es el mismo de
 * siempre, pero el `problem` dice cuál de los siete chequeos falló.
 */
export type IdentityUrlProblem =
  | "URL_NO_ES_DE_CLOUDINARY"
  | "OTRO_CLOUD"
  | "NO_ES_AUTHENTICATED"
  | "FORMATO_NO_PERMITIDO"
  | "FUERA_DE_LA_CARPETA_DE_IDENTIDAD"
  | "OTRA_CUENTA"
  | "SUBCARPETA_INESPERADA"
  | "OTRO_SLOT"
  | "ARCHIVO_NO_EXISTE";

/** Un problema concreto de un archivo concreto, listo para serializar. */
export interface IdentityUrlError {
  /** Código estable del 400 (el que ya consumía el front). */
  code:
    | "INVALID_DOCUMENT_URL"
    | "DOCUMENT_SLOT_MISMATCH"
    | "DOCUMENT_NOT_FOUND";
  /** Cuál de los chequeos falló, dentro de ese código. */
  problem: IdentityUrlProblem;
  /** En qué paso del submit se cayó: sirve para ubicarse en el flujo. */
  step: "parseo_de_url" | "pertenencia" | "existencia";
  /** Campo del body que traía la URL mala. */
  field: DocumentField;
  /** Documento + lado que se esperaba en ese campo. */
  slot: DocumentSlot;
  message: string;
  /** Qué hacer para arreglarlo, en una línea. */
  hint: string;
  /** Lo esperado vs. lo recibido, siempre con datos del propio pedido. */
  details: Record<string, string | string[] | boolean>;
}

type Diagnosis =
  | { ok: true; asset: ParsedAsset }
  | { ok: false; error: IdentityUrlError };

/** Respuesta del endpoint de diagnóstico, para revisar una URL sin enviarla. */
export interface IdentityUrlInspection {
  ok: boolean;
  field: DocumentField;
  slot: DocumentSlot;
  publicId: string | null;
  /** Solo se consulta si la URL pasó todos los chequeos de forma. */
  exists: boolean | null;
  error: IdentityUrlError | null;
}

/** Rama imposible: acá ya se lanzó el 400 con todos los diagnósticos malos. */
function never(): never {
  throw new Error("diagnóstico inválido después de haber validado las URLs");
}

/** Trunca lo que llegó del cliente antes de devolvérselo en un error. */
function short(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
 *
 * Cuando algo de eso no se cumple el 400 no dice solo "no corresponde": dice
 * qué chequeo falló, qué se esperaba y qué llegó. Todo lo que se devuelve es
 * información que el propio cliente mandó, así que no filtra nada de nadie.
 */
@Injectable()
export class IdentityDocumentsService {
  private readonly logger = new Logger(IdentityDocumentsService.name);

  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Firma la subida de UN slot (documento + lado). El cliente hace POST
   * multipart a `uploadUrl` con el archivo en `file` más EXACTAMENTE los
   * pares de `params`: ni uno de más ni uno de menos, o Cloudinary rechaza
   * la firma.
   *
   * El public_id ya trae la carpeta adentro, así que NO se manda `folder`
   * por separado: mandar los dos hace que Cloudinary anteponga la carpeta al
   * public_id y el archivo termine en identity/<id>/identity/<id>/… — que es
   * exactamente lo que después el submit rechaza como slot equivocado.
   */
  signUpload(userId: string, dto: UploadSignatureDto) {
    const folder = identityFolder(userId);
    const slot = slotFor(dto.document, dto.side);
    const publicId = `${folder}/${slot}_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const timestamp = Math.round(Date.now() / 1000);

    const signed = {
      public_id: publicId,
      timestamp,
      type: "authenticated",
    };
    const { cloudName, apiKey, signature } =
      this.cloudinary.signUploadParams(signed);

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
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      /** Copiar tal cual al FormData, más `file`. Nada más, nada menos. */
      params: {
        ...signed,
        timestamp: String(timestamp),
        api_key: apiKey,
        signature,
      },
      /** Cómo tiene que quedar la URL que después se manda al submit. */
      expectedUrl: `https://res.cloudinary.com/${cloudName}/image/authenticated/${publicId}.<ext>`,
    };
  }

  /**
   * Valida las dos URLs de un documento (frente y dorso) y devuelve las
   * formas canónicas sin firma que se persisten. Una URL sin firma sobre un
   * asset authenticated es inerte: Cloudinary responde 401 a quien la tenga.
   *
   * Revisa las DOS antes de fallar: si el frente y el dorso están mal, el
   * error los lista a los dos en `errors` en vez de obligar a descubrirlos de
   * a uno por request (y el rate limit del submit es de 5 cada 15 minutos).
   */
  async validateSubmission(
    userId: string,
    kind: DocumentKind,
    dto: SubmitDocumentDto,
  ): Promise<{ frontUrl: string; backUrl: string }> {
    const targets: { field: DocumentField; slot: DocumentSlot; url: string }[] =
      [
        {
          field: "frontUrl",
          slot: slotFor(kind, "front"),
          url: dto.frontUrl,
        },
        { field: "backUrl", slot: slotFor(kind, "back"), url: dto.backUrl },
      ];

    const diagnoses = targets.map((target) => ({
      ...target,
      diagnosis: this.diagnose(userId, target.slot, target.field, target.url),
    }));

    const failures = diagnoses
      .map(({ diagnosis }) => (diagnosis.ok ? null : diagnosis.error))
      .filter((error): error is IdentityUrlError => error !== null);
    if (failures.length > 0) {
      throw new BadRequestException(this.toResponse(failures));
    }

    // La existencia real solo se consulta cuando las dos URLs tienen forma
    // válida: preguntarle a Cloudinary por un public_id que ya sabemos que
    // está mal solo agrega ruido al diagnóstico.
    const assets = diagnoses.map(({ diagnosis }) =>
      diagnosis.ok ? diagnosis.asset : never(),
    );
    const existence = await Promise.all(
      assets.map((asset) => this.cloudinary.resourceExists(asset.publicId)),
    );
    diagnoses.forEach(({ field, slot }, index) => {
      if (!existence[index]) {
        failures.push(this.notFoundError(field, slot, assets[index].publicId));
      }
    });

    if (failures.length > 0) {
      throw new BadRequestException(this.toResponse(failures));
    }

    return {
      frontUrl: this.canonicalUrl(assets[0]),
      backUrl: this.canonicalUrl(assets[1]),
    };
  }

  /**
   * Revisa UNA url sin enviarla a verificar: mismo diagnóstico que el submit
   * pero con 200 y sin consumir el rate limit del submit. Es lo que permite
   * que el front diga "esta foto está mal cargada" antes de mandar nada.
   */
  async inspect(
    userId: string,
    kind: DocumentKind,
    side: "front" | "back",
    url: string,
  ): Promise<IdentityUrlInspection> {
    const slot = slotFor(kind, side);
    const field: DocumentField = side === "front" ? "frontUrl" : "backUrl";
    const diagnosis = this.diagnose(userId, slot, field, url);

    if (!diagnosis.ok) {
      return {
        ok: false,
        field,
        slot,
        publicId: null,
        exists: null,
        error: diagnosis.error,
      };
    }

    const exists = await this.cloudinary.resourceExists(
      diagnosis.asset.publicId,
    );
    return {
      ok: exists,
      field,
      slot,
      publicId: diagnosis.asset.publicId,
      exists,
      error: exists
        ? null
        : this.notFoundError(field, slot, diagnosis.asset.publicId),
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
    const parts = this.splitCloudinaryUrl(url);
    if (
      !parts ||
      parts.cloudName !== this.cloudinary.getCloudName() ||
      parts.deliveryType !== "authenticated"
    ) {
      return null;
    }
    return this.splitPublicId(parts.rest);
  }

  // ── Diagnóstico ────────────────────────────────────────────────────────

  /**
   * Los siete chequeos que tiene que pasar una URL, en orden, informando
   * cuál falló. El orden importa: cada paso asume que el anterior pasó.
   */
  private diagnose(
    userId: string,
    slot: DocumentSlot,
    field: DocumentField,
    rawUrl: string,
  ): Diagnosis {
    const url = rawUrl.trim();
    const fail = (
      code: IdentityUrlError["code"],
      problem: IdentityUrlProblem,
      step: IdentityUrlError["step"],
      message: string,
      hint: string,
      details: IdentityUrlError["details"],
    ): Diagnosis => ({
      ok: false,
      error: { code, problem, step, field, slot, message, hint, details },
    });

    const expectedCloud = this.cloudinary.getCloudName();
    const expectedFolder = identityFolder(userId);
    const expectedPrefix = `${expectedFolder}/${slot}_`;

    // 1 · ¿Es una URL de entrega de Cloudinary?
    const parts = this.splitCloudinaryUrl(url);
    if (!parts) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "URL_NO_ES_DE_CLOUDINARY",
        "parseo_de_url",
        "La URL no es una URL de entrega de Cloudinary",
        "Mandá el secure_url que devolvió la subida firmada, sin recortarlo ni reescribirlo",
        {
          recibido: short(url),
          formatoEsperado: `https://res.cloudinary.com/${expectedCloud}/image/authenticated/${expectedPrefix}<...>.jpg`,
        },
      );
    }

    // 2 · ¿Es NUESTRA cuenta de Cloudinary?
    if (parts.cloudName !== expectedCloud) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "OTRO_CLOUD",
        "parseo_de_url",
        "La URL es de otra cuenta de Cloudinary",
        "El front está subiendo a un cloud distinto del que usa el backend: usá el cloudName que devuelve /verification/identity/upload-signature",
        { cloudRecibido: parts.cloudName, cloudEsperado: expectedCloud },
      );
    }

    // 3 · ¿Se subió como authenticated? (el error más común: subida pública)
    if (parts.deliveryType !== "authenticated") {
      return fail(
        "INVALID_DOCUMENT_URL",
        "NO_ES_AUTHENTICATED",
        "parseo_de_url",
        `El archivo se subió como "${parts.deliveryType}" y los documentos tienen que ser "authenticated"`,
        'Agregá el campo type="authenticated" al FormData de la subida (viene en params.type de la firma) y volvé a subir la foto',
        {
          tipoRecibido: parts.deliveryType,
          tipoEsperado: "authenticated",
          recibido: short(url),
        },
      );
    }

    // 4 · ¿Tiene un formato de imagen que aceptamos?
    const asset = this.splitPublicId(parts.rest);
    if (!asset || !ALLOWED_FORMATS.includes(asset.format)) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "FORMATO_NO_PERMITIDO",
        "parseo_de_url",
        "El archivo no tiene una extensión de imagen aceptada",
        "Subí la foto como jpg, jpeg, png o webp (un PDF o un HEIC no sirven)",
        {
          formatoRecibido: asset?.format ?? "(sin extensión)",
          formatosPermitidos: ALLOWED_FORMATS,
        },
      );
    }

    // 5 · ¿Está en la carpeta de identidad de ESTE usuario? Se toleran las
    //     carpetas duplicadas (identity/<id>/identity/<id>/…) que dejaban las
    //     subidas viejas, cuando se firmaba folder y public_id a la vez.
    const { relative, duplicated } = this.stripOwnFolder(
      asset.publicId,
      expectedFolder,
    );
    if (relative === null) {
      const otherOwner = /^identity\/([^/]+)\//.exec(asset.publicId);
      if (otherOwner) {
        return fail(
          "DOCUMENT_SLOT_MISMATCH",
          "OTRA_CUENTA",
          "pertenencia",
          "El archivo pertenece a la carpeta de otra cuenta",
          "Pedí una firma nueva con tu propio token y volvé a subir la foto",
          {
            carpetaRecibida: `identity/${otherOwner[1]}`,
            carpetaEsperada: expectedFolder,
          },
        );
      }
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        "FUERA_DE_LA_CARPETA_DE_IDENTIDAD",
        "pertenencia",
        "El archivo no está en la carpeta de documentos de identidad",
        "Subí la foto con los params de /verification/identity/upload-signature: el public_id lo fija el servidor",
        {
          publicIdRecibido: asset.publicId,
          carpetaEsperada: expectedFolder,
        },
      );
    }
    if (relative.includes("/")) {
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        "SUBCARPETA_INESPERADA",
        "pertenencia",
        "El archivo está en una subcarpeta que el servidor no firmó",
        "No agregues carpetas al public_id: mandá el que devuelve la firma tal cual",
        {
          publicIdRecibido: asset.publicId,
          prefijoEsperado: expectedPrefix,
        },
      );
    }

    // 6 · ¿Es el documento y el lado de ESTE campo?
    if (!relative.startsWith(`${slot}_`)) {
      const detected = /^((?:dni|license)_(?:front|back))_/.exec(relative);
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        "OTRO_SLOT",
        "pertenencia",
        detected
          ? `En "${field}" se esperaba ${slot} y llegó un archivo de ${detected[1]}`
          : `El archivo no corresponde a ${slot}`,
        detected
          ? "Cruzaste las fotos: revisá qué URL mandás en frontUrl y cuál en backUrl"
          : "Pedí la firma con el document y el side correctos antes de subir la foto",
        {
          slotEsperado: slot,
          slotRecibido: detected?.[1] ?? "(desconocido)",
          publicIdRecibido: asset.publicId,
          prefijoEsperado: expectedPrefix,
        },
      );
    }

    if (duplicated > 0) {
      this.logger.warn(
        `El public_id ${asset.publicId} repite la carpeta ${duplicated} vez/veces: ` +
          "la subida mandó folder y public_id juntos. Se acepta, pero conviene resubir la foto.",
      );
    }

    return { ok: true, asset };
  }

  private notFoundError(
    field: DocumentField,
    slot: DocumentSlot,
    publicId: string,
  ): IdentityUrlError {
    return {
      code: "DOCUMENT_NOT_FOUND",
      problem: "ARCHIVO_NO_EXISTE",
      step: "existencia",
      field,
      slot,
      message: "El archivo no existe en el almacenamiento",
      hint: "La URL tiene la forma correcta pero Cloudinary no tiene ese archivo: puede que la subida haya fallado o que se haya subido con otro type",
      details: { publicId, tipoConsultado: "authenticated" },
    };
  }

  /** El cuerpo del 400: compatible con lo de antes, más el detalle nuevo. */
  private toResponse(failures: IdentityUrlError[]) {
    const first = failures[0];
    return {
      statusCode: 400,
      code: first.code,
      message:
        failures.length === 1
          ? first.message
          : failures.map((f) => `${f.field}: ${f.message}`).join(" | "),
      slot: first.slot,
      field: first.field,
      problem: first.problem,
      step: first.step,
      hint: first.hint,
      details: first.details,
      /** Todos los archivos con problemas, no solo el primero. */
      errors: failures,
    };
  }

  // ── Parseo ─────────────────────────────────────────────────────────────

  /** cloud, tipo de entrega y resto del path de una URL de res.cloudinary.com */
  private splitCloudinaryUrl(
    url: string,
  ): { cloudName: string; deliveryType: string; rest: string } | null {
    const match =
      /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/image\/([^/]+)\/(.+)$/.exec(
        url.trim(),
      );
    if (!match) return null;
    return { cloudName: match[1], deliveryType: match[2], rest: match[3] };
  }

  /** Saca firma (s--…--) y versión (v123) y separa public_id de extensión. */
  private splitPublicId(rest: string): ParsedAsset | null {
    const match =
      /^(?:s--[A-Za-z0-9_-]+--\/)?(?:v\d+\/)?(.+)\.([A-Za-z0-9]+)$/.exec(rest);
    if (!match) return null;
    return { publicId: match[1], format: match[2].toLowerCase() };
  }

  /**
   * Quita el prefijo de la carpeta del usuario, tantas veces como aparezca
   * repetido. Solo colapsa la carpeta PROPIA: `identity/<otro>/…` nunca se
   * convierte en algo aceptable.
   */
  private stripOwnFolder(
    publicId: string,
    folder: string,
  ): { relative: string | null; duplicated: number } {
    const prefix = `${folder}/`;
    if (!publicId.startsWith(prefix)) return { relative: null, duplicated: 0 };

    let relative = publicId.slice(prefix.length);
    let duplicated = 0;
    while (relative.startsWith(prefix)) {
      relative = relative.slice(prefix.length);
      duplicated += 1;
    }
    return { relative, duplicated };
  }

  private canonicalUrl(asset: ParsedAsset): string {
    return (
      `https://res.cloudinary.com/${this.cloudinary.getCloudName()}` +
      `/image/authenticated/${asset.publicId}.${asset.format}`
    );
  }
}
