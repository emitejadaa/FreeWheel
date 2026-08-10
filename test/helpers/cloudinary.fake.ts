import { CloudinaryService } from "../../src/media/cloudinary.service";

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

  reset(): void {
    this.missing.clear();
    this.bytesByPublicId.clear();
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

/** Las cuatro URLs válidas para un usuario. */
export function identityDocs(userId: string) {
  return {
    dniFrontUrl: identityDocUrl(userId, "dni_front"),
    dniBackUrl: identityDocUrl(userId, "dni_back"),
    licenseFrontUrl: identityDocUrl(userId, "license_front"),
    licenseBackUrl: identityDocUrl(userId, "license_back"),
  };
}
