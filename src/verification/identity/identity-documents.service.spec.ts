import { BadRequestException } from "@nestjs/common";
import { CloudinaryService } from "../../media/cloudinary.service";
import {
  IdentityDocumentsService,
  IdentityUrlError,
} from "./identity-documents.service";

const CLOUD = "test-cloud";
const USER = "user-1";
const OTHER = "user-2";

/** Cloudinary en memoria: alcanza para las reglas de forma y existencia. */
class FakeCloudinary {
  readonly missing = new Set<string>();

  getCloudName(): string {
    return CLOUD;
  }

  signUploadParams(params: Record<string, string | number>) {
    return {
      cloudName: CLOUD,
      apiKey: "fake-key",
      signature: `sig(${Object.keys(params).sort().join(",")})`,
    };
  }

  resourceExists(publicId: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(publicId));
  }
}

function url(publicId: string, format = "jpg", deliveryType = "authenticated") {
  return `https://res.cloudinary.com/${CLOUD}/image/${deliveryType}/${publicId}.${format}`;
}

function doc(userId: string, slot: string, suffix = "1700000000_abcdef01") {
  return `identity/${userId}/${slot}_${suffix}`;
}

/**
 * El diagnóstico de las URLs de identidad. Cada caso comprueba que el 400 no
 * diga solo "no corresponde": tiene que nombrar el chequeo que falló y traer
 * lo esperado junto a lo recibido.
 */
describe("IdentityDocumentsService · diagnóstico de URLs", () => {
  let cloudinary: FakeCloudinary;
  let service: IdentityDocumentsService;

  beforeEach(() => {
    cloudinary = new FakeCloudinary();
    service = new IdentityDocumentsService(
      cloudinary as unknown as CloudinaryService,
    );
  });

  /** Corre el submit y devuelve el cuerpo del 400. */
  async function submitError(
    frontUrl: string,
    backUrl: string,
    kind: "dni" | "license" = "dni",
  ) {
    try {
      await service.validateSubmission(USER, kind, { frontUrl, backUrl });
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse() as {
        code: string;
        problem: string;
        step: string;
        field: string;
        slot: string;
        message: string;
        hint: string;
        details: Record<string, unknown>;
        errors: IdentityUrlError[];
      };
    }
    throw new Error("Se esperaba un 400 y la validación pasó");
  }

  describe("firma de subida", () => {
    it("no firma folder junto al public_id (Cloudinary lo antepondría)", () => {
      const signed = service.signUpload(USER, {
        document: "license",
        side: "front",
      });

      expect(
        signed.publicId.startsWith(`identity/${USER}/license_front_`),
      ).toBe(true);
      expect(Object.keys(signed.params).sort()).toEqual([
        "api_key",
        "public_id",
        "signature",
        "timestamp",
        "type",
      ]);
      expect(signed.signature).toBe("sig(public_id,timestamp,type)");
      expect(signed.uploadUrl).toBe(
        `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
      );
    });
  });

  describe("URLs válidas", () => {
    it("acepta las dos fotos y persiste la forma canónica sin firma", async () => {
      const result = await service.validateSubmission(USER, "dni", {
        frontUrl: `https://res.cloudinary.com/${CLOUD}/image/authenticated/s--abc123--/v1700000000/${doc(USER, "dni_front")}.jpg`,
        backUrl: url(doc(USER, "dni_back")),
      });

      expect(result).toEqual({
        frontUrl: url(doc(USER, "dni_front")),
        backUrl: url(doc(USER, "dni_back")),
      });
    });

    it("tolera la carpeta duplicada que dejaban las subidas viejas", async () => {
      const duplicated = `identity/${USER}/${doc(USER, "dni_front")}`;
      const result = await service.validateSubmission(USER, "dni", {
        frontUrl: url(duplicated),
        backUrl: url(doc(USER, "dni_back")),
      });

      // Se conserva el public_id REAL: es donde está el archivo de verdad.
      expect(result.frontUrl).toBe(url(duplicated));
    });
  });

  describe("cada chequeo dice cuál falló", () => {
    it("URL que no es de Cloudinary", async () => {
      const body = await submitError(
        "https://example.com/dni-frente.png",
        url(doc(USER, "dni_back")),
      );

      expect(body.code).toBe("INVALID_DOCUMENT_URL");
      expect(body.problem).toBe("URL_NO_ES_DE_CLOUDINARY");
      expect(body.step).toBe("parseo_de_url");
      expect(body.field).toBe("frontUrl");
      expect(body.slot).toBe("dni_front");
    });

    it("otra cuenta de Cloudinary, nombrando los dos clouds", async () => {
      const body = await submitError(
        `https://res.cloudinary.com/otro-cloud/image/authenticated/${doc(USER, "dni_front")}.jpg`,
        url(doc(USER, "dni_back")),
      );

      expect(body.problem).toBe("OTRO_CLOUD");
      expect(body.details).toMatchObject({
        cloudRecibido: "otro-cloud",
        cloudEsperado: CLOUD,
      });
    });

    it("subida pública en vez de authenticated", async () => {
      const body = await submitError(
        url(doc(USER, "dni_front"), "jpg", "upload"),
        url(doc(USER, "dni_back")),
      );

      expect(body.problem).toBe("NO_ES_AUTHENTICATED");
      expect(body.details).toMatchObject({
        tipoRecibido: "upload",
        tipoEsperado: "authenticated",
      });
      expect(body.hint).toContain("authenticated");
    });

    it("extensión no aceptada", async () => {
      const body = await submitError(
        url(doc(USER, "dni_front"), "pdf"),
        url(doc(USER, "dni_back")),
      );

      expect(body.problem).toBe("FORMATO_NO_PERMITIDO");
      expect(body.details.formatoRecibido).toBe("pdf");
    });

    it("archivo de la carpeta de otra cuenta", async () => {
      const body = await submitError(
        url(doc(OTHER, "dni_front")),
        url(doc(USER, "dni_back")),
      );

      expect(body.code).toBe("DOCUMENT_SLOT_MISMATCH");
      expect(body.problem).toBe("OTRA_CUENTA");
      expect(body.step).toBe("pertenencia");
      expect(body.details).toMatchObject({
        carpetaRecibida: `identity/${OTHER}`,
        carpetaEsperada: `identity/${USER}`,
      });
    });

    it("fuera de la carpeta de identidad", async () => {
      const body = await submitError(
        url("listings/foto-suelta"),
        url(doc(USER, "dni_back")),
      );

      expect(body.problem).toBe("FUERA_DE_LA_CARPETA_DE_IDENTIDAD");
    });

    it("slot cruzado: dice qué se esperaba y qué llegó", async () => {
      const body = await submitError(
        url(doc(USER, "license_back")),
        url(doc(USER, "dni_back")),
      );

      expect(body.code).toBe("DOCUMENT_SLOT_MISMATCH");
      expect(body.problem).toBe("OTRO_SLOT");
      expect(body.details).toMatchObject({
        slotEsperado: "dni_front",
        slotRecibido: "license_back",
      });
      expect(body.message).toContain("license_back");
    });

    it("archivo que nunca llegó a Cloudinary", async () => {
      cloudinary.missing.add(doc(USER, "license_front"));
      const body = await submitError(
        url(doc(USER, "license_front")),
        url(doc(USER, "license_back")),
        "license",
      );

      expect(body.code).toBe("DOCUMENT_NOT_FOUND");
      expect(body.problem).toBe("ARCHIVO_NO_EXISTE");
      expect(body.step).toBe("existencia");
      expect(body.details.publicId).toBe(doc(USER, "license_front"));
    });

    it("informa los DOS archivos cuando los dos están mal", async () => {
      const body = await submitError(
        url(doc(USER, "license_front")),
        "no-es-una-url",
        "dni",
      );

      expect(body.errors).toHaveLength(2);
      expect(body.errors.map((error) => error.field)).toEqual([
        "frontUrl",
        "backUrl",
      ]);
      expect(body.errors[0].problem).toBe("OTRO_SLOT");
      expect(body.errors[1].problem).toBe("URL_NO_ES_DE_CLOUDINARY");
      expect(body.message).toContain("frontUrl");
      expect(body.message).toContain("backUrl");
    });
  });

  describe("inspect: mismo diagnóstico, sin efectos", () => {
    it("confirma una URL correcta", async () => {
      const inspection = await service.inspect(
        USER,
        "license",
        "back",
        url(doc(USER, "license_back")),
      );

      expect(inspection).toMatchObject({
        ok: true,
        field: "backUrl",
        slot: "license_back",
        publicId: doc(USER, "license_back"),
        exists: true,
        error: null,
      });
    });

    it("explica el slot cruzado sin lanzar", async () => {
      const inspection = await service.inspect(
        USER,
        "license",
        "front",
        url(doc(USER, "dni_front")),
      );

      expect(inspection.ok).toBe(false);
      expect(inspection.error?.problem).toBe("OTRO_SLOT");
      expect(inspection.error?.slot).toBe("license_front");
      expect(inspection.exists).toBeNull();
    });

    it("distingue la URL bien formada cuyo archivo no existe", async () => {
      cloudinary.missing.add(doc(USER, "dni_front"));
      const inspection = await service.inspect(
        USER,
        "dni",
        "front",
        url(doc(USER, "dni_front")),
      );

      expect(inspection.ok).toBe(false);
      expect(inspection.exists).toBe(false);
      expect(inspection.error?.code).toBe("DOCUMENT_NOT_FOUND");
    });
  });
});
