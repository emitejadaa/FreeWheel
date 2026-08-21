import { writeBarcode } from "zxing-wasm/full";
import {
  BarcodeDecoderService,
  IdentityBarcodeFormat,
  prepareZxingForNode,
} from "./barcode-decoder.service";
import {
  DocumentPrecheckService,
  decodeImageDataUrl,
} from "./document-precheck.service";

// Payload sintético con la forma del PDF417 de un DNI. Nunca se commitean
// imágenes de documentos reales: el fixture se genera en memoria.
const DNI_PDF417 =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/02/1990@05/03/2015";
const LICENSE_QR = "DNI=12345678;VTO=20/05/2031";

async function dataUrl(
  text: string,
  format: IdentityBarcodeFormat,
): Promise<string> {
  const { image, error } = await writeBarcode(text, { format });
  if (!image) throw new Error(`writeBarcode falló: ${error}`);
  const bytes = Buffer.from(await image.arrayBuffer());
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/**
 * El chequeo de cada foto se le pedía enteramente a un modelo de visión, así
 * que cuando el modelo fallaba la pantalla contestaba "no se pudo interpretar
 * la revisión automática" con cualquier imagen y no había manera de avanzar.
 * El PDF417 del DNI lo imprime el RENAPER y lo lee un decodificador: si está y
 * dice lo que tiene que decir, la foto es un DNI sin preguntarle a nadie.
 */
describe("DocumentPrecheckService", () => {
  let service: DocumentPrecheckService;
  let dniPhoto: string;
  let licensePhoto: string;

  beforeAll(async () => {
    // wasm local: la suite no depende de la red.
    prepareZxingForNode();
    service = new DocumentPrecheckService(new BarcodeDecoderService());
    dniPhoto = await dataUrl(DNI_PDF417, "PDF417");
    licensePhoto = await dataUrl(LICENSE_QR, "QRCode");
  }, 30000);

  it("da por buena la foto del DNI leyendo su PDF417, sin modelo", async () => {
    const result = await service.check(dniPhoto, "DNI_FRONT");

    expect(result).toMatchObject({
      matches: true,
      documentNumber: "12345678",
      fullName: "PEREZ JUAN CARLOS",
    });
  }, 30000);

  it("sirve para las dos caras: el código está en una o en otra según el ejemplar", async () => {
    expect((await service.check(dniPhoto, "DNI_BACK"))?.matches).toBe(true);
  }, 30000);

  it("rechaza el DNI subido donde va la licencia", async () => {
    const result = await service.check(dniPhoto, "LICENSE_FRONT");

    expect(result?.matches).toBe(false);
    expect(result?.reason).toContain("licencia");
  }, 30000);

  it("da por buena la licencia cuando su código trae datos", async () => {
    const result = await service.check(licensePhoto, "LICENSE_BACK");

    expect(result).toMatchObject({
      matches: true,
      documentNumber: "12345678",
      expiresAt: "2031-05-20",
    });
  }, 30000);

  it("responde el motivo en el idioma pedido", async () => {
    const result = await service.check(dniPhoto, "DNI_FRONT", "en");
    expect(result?.reason).toContain("PDF417");
    expect(result?.reason).toContain("photo");
  }, 30000);

  /**
   * null = "no puedo concluir yo solo". Ahí recién se le pregunta al modelo.
   * Nunca se contesta que la foto está mal solo porque no tenga código: el
   * dorso del DNI y el frente de la licencia no traen ninguno.
   */
  it("se aparta cuando la foto no trae un código legible", async () => {
    const sinCodigo = await dataUrl("texto cualquiera", "QRCode");

    expect(await service.check(sinCodigo, "DNI_FRONT")).toBeNull();
    expect(await service.check(sinCodigo, "LICENSE_FRONT")).toBeNull();
    expect(
      await service.check("data:image/png;base64,AAAA", "DNI_FRONT"),
    ).toBeNull();
  }, 30000);

  it("no sale a descargar una URL que le pasen (eso sería SSRF)", async () => {
    expect(
      await service.check("https://ejemplo.test/dni.jpg", "DNI_FRONT"),
    ).toBeNull();
  }, 30000);
});

describe("decodeImageDataUrl", () => {
  it("acepta los formatos de imagen que se suben", () => {
    const png = "data:image/png;base64,AAECAw==";
    expect(decodeImageDataUrl(png)).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(
      decodeImageDataUrl("data:image/jpeg;base64,AAECAw=="),
    ).not.toBeNull();
    expect(
      decodeImageDataUrl("data:image/webp;base64,AAECAw=="),
    ).not.toBeNull();
  });

  it("rechaza lo que no es un dataURL de imagen", () => {
    expect(decodeImageDataUrl("https://ejemplo.test/foto.jpg")).toBeNull();
    expect(decodeImageDataUrl("data:text/html;base64,AAECAw==")).toBeNull();
    expect(decodeImageDataUrl("data:image/png;base64,")).toBeNull();
  });
});
