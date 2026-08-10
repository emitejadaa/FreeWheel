import { writeBarcode } from "zxing-wasm/full";
import {
  BarcodeDecoderService,
  IdentityBarcodeFormat,
  prepareZxingForNode,
} from "./barcode-decoder.service";

// Payload sintético con la forma del PDF417 de un DNI nuevo. Nunca se
// commitean imágenes de documentos reales: los fixtures se generan en memoria
// con el writer de zxing y se decodifican con el mismo módulo (roundtrip).
const SAMPLE_DNI_PDF417 =
  "00123456789@PEREZ@JUAN CARLOS@M@12345678@A@01/01/1990@05/03/2015";

async function barcodePng(
  text: string,
  format: IdentityBarcodeFormat,
): Promise<Uint8Array> {
  const { image, error } = await writeBarcode(text, { format });
  if (!image) {
    throw new Error(`writeBarcode failed: ${error}`);
  }
  return new Uint8Array(await image.arrayBuffer());
}

describe("BarcodeDecoderService", () => {
  let service: BarcodeDecoderService;

  beforeAll(() => {
    // Fija el wasmBinary local antes de cualquier write/read para que la
    // suite no dependa de la red (default de zxing-wasm: CDN de jsDelivr).
    prepareZxingForNode();
    service = new BarcodeDecoderService();
  });

  it("decodifica un PDF417 con payload estilo DNI (roundtrip write→read)", async () => {
    const png = await barcodePng(SAMPLE_DNI_PDF417, "PDF417");
    const results = await service.decode(png, ["PDF417"]);
    expect(results).toEqual([{ format: "PDF417", text: SAMPLE_DNI_PDF417 }]);
  }, 30000);

  it("decodifica un QR (roundtrip write→read)", async () => {
    const payload = "https://example.com/licencia/ABC123";
    const png = await barcodePng(payload, "QRCode");
    const results = await service.decode(png, ["QRCode"]);
    expect(results).toEqual([{ format: "QRCode", text: payload }]);
  }, 30000);

  it("no devuelve formatos que no fueron pedidos", async () => {
    const png = await barcodePng(SAMPLE_DNI_PDF417, "PDF417");
    const results = await service.decode(png, ["QRCode"]);
    expect(results).toEqual([]);
  }, 30000);

  it("devuelve lista vacía ante bytes que no son una imagen", async () => {
    const results = await service.decode(new Uint8Array([1, 2, 3, 4]), [
      "PDF417",
      "QRCode",
    ]);
    expect(results).toEqual([]);
  }, 30000);
});
