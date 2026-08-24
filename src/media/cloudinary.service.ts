import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";

/**
 * Integración con Cloudinary hand-rolled sobre fetch + crypto (mismo idioma
 * que la firma original de MediaService y el proxy Groq: sin SDK). Si la
 * firma de entrega diera problemas contra la cuenta real, el fallback
 * documentado es reemplazar los internals por el SDK oficial `cloudinary`
 * tocando solo este archivo.
 *
 * El API secret nunca sale del backend; los assets de identidad se suben con
 * type=authenticated, así que sus URLs sin firma devuelven 401 y solo este
 * servicio puede generar URLs de entrega firmadas (efímeras, para el admin y
 * para la descarga interna del reviewer).
 */
@Injectable()
export class CloudinaryService {
  constructor(private readonly config: ConfigService) {}

  private credentials() {
    const cloudName = this.config.get<string>("CLOUDINARY_CLOUD_NAME");
    const apiKey = this.config.get<string>("CLOUDINARY_API_KEY");
    const apiSecret = this.config.get<string>("CLOUDINARY_API_SECRET");

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        "Cloudinary no esta configurado en el servidor",
      );
    }

    return { cloudName, apiKey, apiSecret };
  }

  getCloudName(): string {
    return this.credentials().cloudName;
  }

  /**
   * De una URL de Cloudinary ya guardada al `public_id` que hace falta para
   * borrarla.
   *
   * POR QUÉ SE PARSEA LA URL Y NO SE USA storageKey
   * `MediaAsset.storageKey` es opcional y lo manda el front al registrar el
   * archivo: la mayoría de las filas lo tienen en null. La URL, en cambio, está
   * siempre —es lo único que se necesita para mostrar la foto—, así que es el
   * único dato con el que se puede llegar al archivo en todos los casos.
   *
   * FORMATO
   *   https://res.cloudinary.com/<cloud>/<recurso>/<entrega>/[s--firma--/][v123/]<public_id>.<ext>
   * `entrega` es `upload` para las fotos públicas (perfil, autos, avisos) y
   * `authenticated` para los documentos de identidad, que es justamente el dato
   * que hay que pasarle a destroy(): con el tipo equivocado Cloudinary no
   * encuentra el archivo y no borra nada.
   *
   * DEVUELVE null ANTE CUALQUIER DUDA
   * Si la URL no tiene exactamente esta forma —otra cuenta de Cloudinary, una
   * URL con transformaciones, un link a otro servicio— se devuelve null y el
   * archivo NO se toca. Dejar un archivo sin borrar es un desperdicio de
   * espacio; borrar el archivo equivocado es borrarle la foto a otra persona.
   */
  parseAssetUrl(url: string): ParsedCloudinaryAsset | null {
    return parseCloudinaryUrl(this.getCloudName(), url);
  }

  /**
   * Borra el archivo al que apunta una URL guardada. Devuelve false si la URL
   * no se pudo interpretar (ver parseAssetUrl) o si Cloudinary no lo encontró
   * —que, para borrar, es el resultado buscado igual—.
   */
  async destroyByUrl(url: string): Promise<boolean> {
    const asset = this.parseAssetUrl(url);
    if (!asset) return false;

    return this.destroy(asset.publicId, asset.deliveryType);
  }

  /**
   * Firma de subida multi-param: SHA1 sobre los pares k=v ordenados
   * alfabéticamente + secret. El cliente debe mandar a Cloudinary exactamente
   * estos params (más file y api_key) o la subida es rechazada.
   */
  signUploadParams(params: Record<string, string | number>): {
    cloudName: string;
    apiKey: string;
    signature: string;
  } {
    const { cloudName, apiKey, apiSecret } = this.credentials();

    const toSign = Object.keys(params)
      .filter((key) => params[key] !== undefined && params[key] !== "")
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");
    const signature = createHash("sha1")
      .update(toSign + apiSecret)
      .digest("hex");

    return { cloudName, apiKey, signature };
  }

  /**
   * Chequeo de existencia vía Admin API (Basic auth con key:secret). 404 →
   * false; cualquier otro fallo es un problema de infraestructura y se
   * propaga como 503: nunca hay que confundir "no pude chequear" con "existe".
   */
  async resourceExists(
    publicId: string,
    deliveryType = "authenticated",
  ): Promise<boolean> {
    const { cloudName, apiKey, apiSecret } = this.credentials();
    const url =
      `https://api.cloudinary.com/v1_1/${cloudName}` +
      `/resources/image/${deliveryType}/${encodeURI(publicId)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
      },
    });

    if (response.status === 404) return false;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Cloudinary Admin API respondió ${response.status}`,
      );
    }
    return true;
  }

  /**
   * URL de entrega firmada para un asset authenticated:
   * `.../image/authenticated/s--<sig>--/<transformation>/<publicId>.<ext>`
   * donde sig = primeros 8 chars de base64url(SHA1(path + secret)).
   */
  signedDeliveryUrl(
    publicId: string,
    options: { transformation?: string; format?: string } = {},
  ): string {
    const { cloudName, apiSecret } = this.credentials();

    const file = options.format ? `${publicId}.${options.format}` : publicId;
    const path = [options.transformation, file].filter(Boolean).join("/");
    const signature = createHash("sha1")
      .update(path + apiSecret)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .slice(0, 8);

    return `https://res.cloudinary.com/${cloudName}/image/authenticated/s--${signature}--/${path}`;
  }

  /**
   * Borrado definitivo de un asset. Se usa cuando una verificación se
   * rechaza o se reemplaza: los documentos de identidad no deben quedar
   * huérfanos en el storage. Devuelve false si Cloudinary no lo encontró
   * (ya borrado: el resultado deseado), y lanza 503 en fallos reales para
   * que quien llama decida si el borrado era imprescindible.
   */
  async destroy(
    publicId: string,
    deliveryType = "authenticated",
  ): Promise<boolean> {
    const { cloudName, apiKey, apiSecret } = this.credentials();

    const timestamp = Math.round(Date.now() / 1000);
    const params: Record<string, string | number> = {
      public_id: publicId,
      timestamp,
      type: deliveryType,
      invalidate: "true",
    };
    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");
    const signature = createHash("sha1")
      .update(toSign + apiSecret)
      .digest("hex");

    const body = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      api_key: apiKey,
      signature,
    });

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
      { method: "POST", body },
    );
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Cloudinary destroy respondió ${response.status}`,
      );
    }
    const result = (await response.json()) as { result?: string };
    return result.result === "ok";
  }

  /** Descarga server-side de un asset authenticated (URL firmada efímera). */
  async download(
    publicId: string,
    options: { transformation?: string; format?: string } = {},
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const url = this.signedDeliveryUrl(publicId, options);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `No se pudo descargar el documento (${response.status})`,
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "image/jpeg",
    };
  }
}

export interface ParsedCloudinaryAsset {
  publicId: string;
  deliveryType: string;
  format: string;
}

/**
 * La implementación de CloudinaryService.parseAssetUrl, como función pura.
 *
 * Está afuera de la clase para que el doble de Cloudinary de los tests
 * (test/helpers/cloudinary.fake.ts) use EXACTAMENTE esta y no una copia: si el
 * fake parseara distinto, los tests estarían probando otro parser que el que
 * corre en producción, que es la única parte de esto que puede borrar el
 * archivo equivocado.
 */
export function parseCloudinaryUrl(
  cloudName: string,
  url: string,
): ParsedCloudinaryAsset | null {
  if (typeof url !== "string") return null;

  const match = new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegex(cloudName)}` +
      `/(?:image|video|raw)/(upload|authenticated|private)/` +
      `(?:s--[A-Za-z0-9_-]+--/)?(?:v\\d+/)?` +
      `([A-Za-z0-9_\\-./]+)\\.([A-Za-z0-9]+)$`,
  ).exec(url);
  if (!match) return null;

  return {
    deliveryType: match[1],
    publicId: match[2],
    format: match[3].toLowerCase(),
  };
}

/** Escapa un texto para meterlo dentro de una expresión regular. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
