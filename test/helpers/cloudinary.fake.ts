import {
  CloudinaryService,
  parseCloudinaryUrl,
} from "../../src/media/cloudinary.service";

export const FAKE_CLOUD_NAME = "test-cloud";

/**
 * Cloudinary en memoria para E2E: no hay red ni credenciales. Por defecto
 * todo asset "existe" (los tests construyen URLs con el mismo formato que
 * firma el backend); `missing` permite simular un archivo nunca subido y
 * `bytesByPublicId` alimenta al lector de códigos en los tests del reviewer.
 */
export class FakeCloudinaryService {
  readonly missing = new Set<string>();
  readonly bytesByPublicId = new Map<string, Uint8Array>();

  getCloudName(): string {
    return FAKE_CLOUD_NAME;
  }

  signUploadParams(params: Record<string, string | number>) {
    return {
      cloudName: FAKE_CLOUD_NAME,
      apiKey: "fake-api-key",
      signature: `fake-signature-${Object.keys(params).sort().join(".")}`,
    };
  }

  resourceExists(publicId: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(publicId));
  }

  signedDeliveryUrl(
    publicId: string,
    options: { transformation?: string; format?: string } = {},
  ): string {
    const file = options.format ? `${publicId}.${options.format}` : publicId;
    const path = [options.transformation, file].filter(Boolean).join("/");
    return `https://res.cloudinary.com/${FAKE_CLOUD_NAME}/image/authenticated/s--fakesig--/${path}`;
  }

  /**
   * Sin bytes registrados devuelve el propio publicId codificado: así los
   * fakes de decodificador y OCR pueden saber de qué documento/lado es la
   * "imagen" que reciben, sin necesitar fotos reales.
   */
  download(publicId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return Promise.resolve({
      bytes:
        this.bytesByPublicId.get(publicId) ??
        new TextEncoder().encode(publicId),
      mimeType: "image/jpeg",
    });
  }

  /** publicIds borrados vía destroy(), para poder asertarlo en los tests. */
  readonly destroyed: string[] = [];

  destroy(publicId: string): Promise<boolean> {
    this.destroyed.push(publicId);
    this.missing.add(publicId);
    return Promise.resolve(true);
  }

  // Usa la misma función que el servicio real: si el fake parseara distinto,
  // los tests estarían probando otro parser que el que corre en producción.
  parseAssetUrl(url: string) {
    return parseCloudinaryUrl(FAKE_CLOUD_NAME, url);
  }

  destroyByUrl(url: string): Promise<boolean> {
    const asset = this.parseAssetUrl(url);
    if (!asset) return Promise.resolve(false);
    return this.destroy(asset.publicId);
  }

  reset(): void {
    this.missing.clear();
    this.bytesByPublicId.clear();
    this.destroyed.length = 0;
  }

  /** Tipado para .overrideProvider(CloudinaryService).useValue(fake). */
  asService(): CloudinaryService {
    return this as unknown as CloudinaryService;
  }
}

/** URL con el formato exacto que el backend firma y valida para un slot. */
export function identityDocUrl(
  userId: string,
  slot: "dni_front" | "dni_back" | "license_front" | "license_back",
  suffix = "1700000000_abcdef01",
): string {
  return (
    `https://res.cloudinary.com/${FAKE_CLOUD_NAME}/image/authenticated` +
    `/identity/${userId}/${slot}_${suffix}.jpg`
  );
}

/** Las dos URLs (frente y dorso) de un documento, con formato válido. */
export function documentUrls(
  userId: string,
  kind: "dni" | "license",
  suffix = "1700000000_abcdef01",
) {
  return {
    frontUrl: identityDocUrl(userId, `${kind}_front`, suffix),
    backUrl: identityDocUrl(userId, `${kind}_back`, suffix),
  };
}
