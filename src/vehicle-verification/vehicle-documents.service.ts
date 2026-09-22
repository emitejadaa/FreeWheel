import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { CloudinaryService } from "../media/cloudinary.service";

/**
 * Carpeta reservada: solo este servicio firma subidas dentro de ella. La firma
 * genérica de MediaService la rechaza, así nadie puede meter un archivo acá con
 * una firma pensada para fotos públicas.
 */
export const VEHICLE_DOCS_FOLDER_PREFIX = "vehicle-docs";

export function vehicleDocsFolder(ownerId: string, vehicleId: string): string {
  return `${VEHICLE_DOCS_FOLDER_PREFIX}/${ownerId}/${vehicleId}`;
}

export type CedulaSide = "front" | "back";
export type CedulaSlot = "cedula_front" | "cedula_back";
export type CedulaField = "cedulaFrontUrl" | "cedulaBackUrl";

export function cedulaSlot(side: CedulaSide): CedulaSlot {
  return `cedula_${side}`;
}

const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

/** Por qué una URL de la cédula no sirve, dentro del código del 400. */
export type CedulaUrlProblem =
  | "URL_NO_ES_DE_CLOUDINARY"
  | "OTRO_CLOUD"
  | "NO_ES_UNA_IMAGEN"
  | "NO_ES_AUTHENTICATED"
  | "FORMATO_NO_PERMITIDO"
  | "FUERA_DE_LA_CARPETA_DEL_AUTO"
  | "OTRO_AUTO_U_OTRA_CUENTA"
  | "SUBCARPETA_INESPERADA"
  | "OTRO_SLOT"
  | "ARCHIVO_NO_EXISTE";

export interface CedulaUrlError {
  code:
    | "INVALID_DOCUMENT_URL"
    | "DOCUMENT_SLOT_MISMATCH"
    | "DOCUMENT_NOT_FOUND";
  problem: CedulaUrlProblem;
  field: CedulaField;
  slot: CedulaSlot;
  message: string;
  hint: string;
  details: Record<string, string | string[]>;
}

interface Asset {
  publicId: string;
  format: string;
}

type Diagnosis =
  | { ok: true; asset: Asset }
  | { ok: false; error: CedulaUrlError };

/** Trunca lo que llegó del cliente antes de devolvérselo en un error. */
function short(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * LOS ARCHIVOS DE LA CÉDULA DEL AUTO: firma de subida por lado, validación de
 * que cada URL enviada es nuestra y de este auto, y borrado.
 *
 * Es el mismo circuito que los documentos de identidad
 * (verification/identity/identity-documents.service.ts), con una carpeta por
 * AUTO y no por persona: vehicle-docs/<dueño>/<auto>/. Con una carpeta por
 * persona, la cédula de un auto se podía mandar como la de otro auto del mismo
 * dueño, y el admin aprobaría el segundo mirando los papeles del primero.
 *
 * Las reglas de seguridad son las de identidad:
 * - carpeta y public_id los fija el servidor a partir del JWT y del auto;
 * - type=authenticated: la cédula lleva nombre y DNI del titular, no puede ser
 *   legible por quien tenga el link;
 * - el envío solo acepta URLs de nuestro cloud, en la carpeta de este auto, del
 *   lado correcto, y que existan de verdad.
 */
@Injectable()
export class VehicleDocumentsService {
  private readonly logger = new Logger(VehicleDocumentsService.name);

  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Firma la subida de UN lado de la cédula. El cliente hace POST multipart a
   * `uploadUrl` con el archivo en `file` más EXACTAMENTE los pares de `params`.
   *
   * No se firma `folder` aparte: el public_id ya la trae, y mandar las dos
   * cosas hace que Cloudinary duplique la carpeta (el mismo problema que tuvo
   * la subida de identidad).
   */
  signUpload(ownerId: string, vehicleId: string, side: CedulaSide) {
    const folder = vehicleDocsFolder(ownerId, vehicleId);
    const slot = cedulaSlot(side);
    const publicId = `${folder}/${slot}_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const timestamp = Math.round(Date.now() / 1000);

    const signed = { public_id: publicId, timestamp, type: "authenticated" };
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
      side,
      slot,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      /** Copiar tal cual al FormData, más `file`. Nada más, nada menos. */
      params: {
        ...signed,
        timestamp: String(timestamp),
        api_key: apiKey,
        signature,
      },
    };
  }

  /**
   * Valida las dos URLs y devuelve sus formas canónicas SIN firma, que es lo
   * que se guarda: sobre un asset authenticated, una URL sin firma es inerte.
   *
   * Revisa las dos antes de fallar, así un frente y un dorso cruzados salen en
   * un solo error en vez de descubrirse de a uno por pedido.
   */
  async validateSubmission(
    ownerId: string,
    vehicleId: string,
    urls: { cedulaFrontUrl: string; cedulaBackUrl: string },
  ): Promise<{ frontUrl: string; backUrl: string }> {
    const targets = [
      { field: "cedulaFrontUrl" as const, side: "front" as const },
      { field: "cedulaBackUrl" as const, side: "back" as const },
    ].map((target) => ({
      ...target,
      diagnosis: this.diagnose(
        ownerId,
        vehicleId,
        target.field,
        cedulaSlot(target.side),
        urls[target.field],
      ),
    }));

    const failures = targets.flatMap(({ diagnosis }) =>
      diagnosis.ok ? [] : [diagnosis.error],
    );
    if (failures.length > 0) {
      throw new BadRequestException(this.toResponse(failures));
    }

    const assets = targets.map(
      ({ diagnosis }) => (diagnosis as { asset: Asset }).asset,
    );

    // La existencia solo se pregunta cuando la forma ya está bien: consultar a
    // Cloudinary por un public_id que sabemos que es de otro auto es gastar una
    // llamada para agregar ruido al error.
    const existence = await Promise.all(
      assets.map((asset) => this.cloudinary.resourceExists(asset.publicId)),
    );
    targets.forEach(({ field, side }, index) => {
      if (!existence[index]) {
        failures.push({
          code: "DOCUMENT_NOT_FOUND",
          problem: "ARCHIVO_NO_EXISTE",
          field,
          slot: cedulaSlot(side),
          message: "La foto no existe en el almacenamiento",
          hint: "La URL tiene la forma correcta pero Cloudinary no tiene ese archivo: puede que la subida haya fallado. Volvé a subir la foto.",
          details: { publicId: assets[index].publicId },
        });
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
   * URL de entrega firmada para que un admin mire la foto. Nunca se guarda ni
   * se le muestra al dueño. null si la URL guardada no es de nuestra carpeta.
   */
  signedUrl(persistedUrl: string | null): string | null {
    const asset = this.ownAsset(persistedUrl);
    if (!asset) return null;
    return this.cloudinary.signedDeliveryUrl(asset.publicId, {
      format: asset.format,
    });
  }

  /**
   * Borra fotos de la cédula. Best-effort registrado: si Cloudinary falla, el
   * flujo sigue —un rechazo o un reenvío no puede quedar trabado por un
   * problema de infraestructura— y el archivo queda nombrado en el log para
   * borrarlo a mano.
   *
   * Solo borra lo que está bajo vehicle-docs/. Si una fila tuviera una URL
   * ajena —un dato corrupto, una carga a mano— borrarla sería borrar el
   * archivo de otra persona; no borrarla es dejar un archivo de más.
   */
  async deleteDocuments(urls: (string | null)[]): Promise<void> {
    for (const url of urls) {
      if (!this.ownAsset(url)) continue;
      try {
        await this.cloudinary.destroyByUrl(url as string);
      } catch (error) {
        this.logger.error(
          `No se pudo borrar ${url} del storage: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  /** El asset de una URL guardada, solo si es una cédula nuestra. */
  private ownAsset(url: string | null): Asset | null {
    if (!url) return null;
    const parsed = this.cloudinary.parseAssetUrl(url);
    if (
      !parsed ||
      parsed.deliveryType !== "authenticated" ||
      !parsed.publicId.startsWith(`${VEHICLE_DOCS_FOLDER_PREFIX}/`)
    ) {
      return null;
    }
    return { publicId: parsed.publicId, format: parsed.format };
  }

  /**
   * Los chequeos que tiene que pasar una URL, en orden. Cada paso asume que el
   * anterior pasó, y el que falla dice qué se esperaba y qué llegó: todo sale
   * de lo que el propio cliente mandó, así que no filtra nada de nadie.
   */
  private diagnose(
    ownerId: string,
    vehicleId: string,
    field: CedulaField,
    slot: CedulaSlot,
    rawUrl: string,
  ): Diagnosis {
    const url = (rawUrl ?? "").trim();
    const fail = (
      code: CedulaUrlError["code"],
      problem: CedulaUrlProblem,
      message: string,
      hint: string,
      details: CedulaUrlError["details"],
    ): Diagnosis => ({
      ok: false,
      error: { code, problem, field, slot, message, hint, details },
    });

    const expectedCloud = this.cloudinary.getCloudName();
    const folder = vehicleDocsFolder(ownerId, vehicleId);

    // 1 · ¿Es una URL de entrega de Cloudinary, y de nuestra cuenta?
    const cloud = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/([^/]+)\//.exec(
      url,
    );
    if (!cloud) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "URL_NO_ES_DE_CLOUDINARY",
        "La URL no es una URL de entrega de Cloudinary",
        "Mandá el secure_url que devolvió la subida firmada, sin recortarlo ni reescribirlo",
        { recibido: short(url) },
      );
    }
    if (cloud[1] !== expectedCloud) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "OTRO_CLOUD",
        "La URL es de otra cuenta de Cloudinary",
        "Usá el cloudName que devuelve la firma de subida de la cédula",
        { cloudRecibido: cloud[1], cloudEsperado: expectedCloud },
      );
    }
    if (cloud[2] !== "image") {
      return fail(
        "INVALID_DOCUMENT_URL",
        "NO_ES_UNA_IMAGEN",
        "El archivo no se subió como imagen",
        "Subí una foto de la cédula (jpg, png o webp) a la uploadUrl de la firma",
        { tipoRecibido: cloud[2], tipoEsperado: "image" },
      );
    }

    // 2 · ¿Se subió como authenticated? Una subida pública de la cédula dejaría
    //     el nombre y el DNI del titular a la vista de cualquiera con el link.
    const parsed = this.cloudinary.parseAssetUrl(url);
    if (!parsed) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "URL_NO_ES_DE_CLOUDINARY",
        "La URL no tiene la forma de un archivo de Cloudinary",
        "Mandá el secure_url que devolvió la subida firmada, sin transformaciones",
        { recibido: short(url) },
      );
    }
    if (parsed.deliveryType !== "authenticated") {
      return fail(
        "INVALID_DOCUMENT_URL",
        "NO_ES_AUTHENTICATED",
        `La foto se subió como "${parsed.deliveryType}" y la cédula tiene que ser "authenticated"`,
        'Mandá el campo type="authenticated" en el FormData (viene en params.type de la firma) y volvé a subir la foto',
        { tipoRecibido: parsed.deliveryType, tipoEsperado: "authenticated" },
      );
    }

    // 3 · ¿Es una imagen que aceptamos?
    if (!ALLOWED_FORMATS.includes(parsed.format)) {
      return fail(
        "INVALID_DOCUMENT_URL",
        "FORMATO_NO_PERMITIDO",
        "La foto no tiene una extensión de imagen aceptada",
        "Subí la foto como jpg, jpeg, png o webp (un PDF o un HEIC no sirven)",
        { formatoRecibido: parsed.format, formatosPermitidos: ALLOWED_FORMATS },
      );
    }

    // 4 · ¿Está en la carpeta de ESTE auto de ESTE dueño?
    const prefix = `${folder}/`;
    if (!parsed.publicId.startsWith(prefix)) {
      const enOtraCarpeta = parsed.publicId.startsWith(
        `${VEHICLE_DOCS_FOLDER_PREFIX}/`,
      );
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        enOtraCarpeta
          ? "OTRO_AUTO_U_OTRA_CUENTA"
          : "FUERA_DE_LA_CARPETA_DEL_AUTO",
        enOtraCarpeta
          ? "La foto pertenece a la cédula de otro auto o de otra cuenta"
          : "La foto no está en la carpeta de documentos del auto",
        "Pedí la firma de subida para ESTE auto y volvé a subir la foto: el public_id lo fija el servidor",
        { publicIdRecibido: parsed.publicId, carpetaEsperada: folder },
      );
    }
    const relative = parsed.publicId.slice(prefix.length);
    if (relative.includes("/")) {
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        "SUBCARPETA_INESPERADA",
        "La foto está en una subcarpeta que el servidor no firmó",
        "No agregues carpetas al public_id: mandá el que devuelve la firma tal cual",
        {
          publicIdRecibido: parsed.publicId,
          prefijoEsperado: `${prefix}${slot}_`,
        },
      );
    }

    // 5 · ¿Es el lado de ESTE campo?
    if (!relative.startsWith(`${slot}_`)) {
      const detected = /^(cedula_(?:front|back))_/.exec(relative)?.[1];
      return fail(
        "DOCUMENT_SLOT_MISMATCH",
        "OTRO_SLOT",
        detected
          ? `En "${field}" se esperaba ${slot} y llegó ${detected}`
          : `La foto no corresponde a ${slot}`,
        detected
          ? "Cruzaste las fotos: revisá qué URL mandás en cedulaFrontUrl y cuál en cedulaBackUrl"
          : "Pedí la firma con el side correcto antes de subir la foto",
        {
          slotEsperado: slot,
          slotRecibido: detected ?? "(desconocido)",
          publicIdRecibido: parsed.publicId,
        },
      );
    }

    return {
      ok: true,
      asset: { publicId: parsed.publicId, format: parsed.format },
    };
  }

  private toResponse(failures: CedulaUrlError[]) {
    const first = failures[0];
    return {
      statusCode: 400,
      code: first.code,
      message:
        failures.length === 1
          ? first.message
          : failures.map((f) => `${f.field}: ${f.message}`).join(" | "),
      field: first.field,
      slot: first.slot,
      problem: first.problem,
      hint: first.hint,
      details: first.details,
      /** Todas las fotos con problemas, no solo la primera. */
      errors: failures,
    };
  }

  private canonicalUrl(asset: Asset): string {
    return (
      `https://res.cloudinary.com/${this.cloudinary.getCloudName()}` +
      `/image/authenticated/${asset.publicId}.${asset.format}`
    );
  }
}
