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
