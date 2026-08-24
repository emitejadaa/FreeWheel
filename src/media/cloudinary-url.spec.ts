import { parseCloudinaryUrl } from "./cloudinary.service";

const CLOUD = "mi-cuenta";
const parse = (url: string) => parseCloudinaryUrl(CLOUD, url);

describe("parseCloudinaryUrl", () => {
  it("saca el public_id de una foto pública (perfil, autos, avisos)", () => {
    expect(
      parse(
        `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/freewheel/auto-1.jpg`,
      ),
    ).toEqual({
      publicId: "freewheel/auto-1",
      deliveryType: "upload",
      format: "jpg",
    });
  });

  it("distingue el tipo de entrega, que es lo que decide si el borrado encuentra el archivo", () => {
    // Los documentos de identidad se suben como authenticated. Pasarle "upload"
    // a destroy() sobre uno de estos no borra nada y no avisa.
    expect(
      parse(
        `https://res.cloudinary.com/${CLOUD}/image/authenticated/identity/u1/dni_front_123.jpg`,
      ),
    ).toEqual({
      publicId: "identity/u1/dni_front_123",
      deliveryType: "authenticated",
      format: "jpg",
    });
  });

  it("ignora la firma y la versión, que no son parte del public_id", () => {
    expect(
      parse(
        `https://res.cloudinary.com/${CLOUD}/image/authenticated/s--AbC1_2-3--/v1700000000/identity/u1/dni_front.png`,
      ),
    ).toMatchObject({ publicId: "identity/u1/dni_front", format: "png" });
  });

  it("acepta carpetas anidadas y el formato en minúsculas", () => {
    expect(
      parse(`https://res.cloudinary.com/${CLOUD}/image/upload/a/b/c.JPEG`),
    ).toMatchObject({ publicId: "a/b/c", format: "jpeg" });
  });

  it("no toca nada de OTRA cuenta de Cloudinary", () => {
    // Si esto devolviera un public_id, un borrado le estaría pegando a los
    // archivos de otra cuenta.
    expect(
      parse("https://res.cloudinary.com/otra-cuenta/image/upload/v1/foto.jpg"),
    ).toBeNull();
  });

  it("devuelve null ante cualquier URL que no tenga exactamente esa forma", () => {
    const raras = [
      "https://ejemplo.com/foto.jpg",
      `http://res.cloudinary.com/${CLOUD}/image/upload/v1/foto.jpg`, // sin https
      `https://res.cloudinary.com/${CLOUD}/image/upload/v1/foto`, // sin extensión
      `https://res.cloudinary.com/${CLOUD}/image/upload/`,
      `https://res.cloudinary.com/${CLOUD}/image/fetch/v1/foto.jpg`, // no es un asset propio
      // Con transformaciones no se arriesga: "c_fill,w_200" se confundiría con
      // una carpeta y se borraría el archivo equivocado.
      `https://res.cloudinary.com/${CLOUD}/image/upload/c_fill,w_200/v1/foto.jpg`,
      "",
    ];
    for (const url of raras) expect(parse(url)).toBeNull();
  });

  it("no explota con algo que no es un texto", () => {
    expect(parse(undefined as unknown as string)).toBeNull();
    expect(parse(null as unknown as string)).toBeNull();
  });
});
