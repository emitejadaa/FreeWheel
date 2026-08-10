import { buildEnvReport } from "./env-report";

/**
 * Lo que importa de este reporte es que sirva para PEDIR lo que falta y que NO
 * filtre nada. Las dos cosas se prueban acá: que nombre las variables ausentes, y
 * que en ninguna parte de la respuesta aparezca un valor.
 */
describe("buildEnvReport", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  /** Deja el entorno con exactamente estas variables cargadas. */
  function soloCon(vars: Record<string, string>) {
    for (const nombre of [
      "DATABASE_URL",
      "JWT_SECRET",
      "GROQ_API_KEY",
      "GMAIL_USER",
      "GMAIL_APP_PASSWORD",
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
      "FRONTEND_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "IDENTITY_REVIEW_MODE",
      "PAYMENTS_PROVIDER",
      "SMS_PROVIDER",
      "REQUIRE_PHONE_VERIFICATION",
      "GROQ_VISION_MODEL",
    ]) {
      delete process.env[nombre];
    }
    Object.assign(process.env, vars);
  }

  it("nombra las variables que faltan", () => {
    soloCon({ DATABASE_URL: "postgres://x", JWT_SECRET: "s" });

    const reporte = buildEnvReport();

    expect(reporte.allSet).toBe(false);
    expect(reporte.missing).toContain("GROQ_API_KEY");
    expect(reporte.missing).toContain("CLOUDINARY_API_SECRET");
    expect(reporte.missing).toContain("FRONTEND_URL");
    // Y lo obligatorio que sí está no aparece como faltante.
    expect(reporte.missing).not.toContain("DATABASE_URL");
  });

  it("dice qué se pierde por cada cosa que falta", () => {
    soloCon({ DATABASE_URL: "postgres://x", JWT_SECRET: "s" });

    const reporte = buildEnvReport();

    expect(reporte.impact.join(" ")).toContain("sin revisar");
    expect(reporte.features["revisión de fotos con IA"]).toBe(false);
    expect(reporte.features["base de datos"]).toBe(true);
  });

  it("un grupo está listo solo si están TODAS sus variables", () => {
    soloCon({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "s",
      CLOUDINARY_CLOUD_NAME: "cuenta",
      CLOUDINARY_API_KEY: "clave",
      // falta CLOUDINARY_API_SECRET
    });

    const reporte = buildEnvReport();

    expect(reporte.features["subida de fotos firmada"]).toBe(false);
    expect(reporte.missing).toEqual(
      expect.arrayContaining(["CLOUDINARY_API_SECRET"]),
    );
    expect(reporte.missing).not.toContain("CLOUDINARY_API_KEY");
  });

  it("una variable vacía o con espacios cuenta como que falta", () => {
    soloCon({ DATABASE_URL: "postgres://x", JWT_SECRET: "   " });

    expect(buildEnvReport().missing).toContain("JWT_SECRET");
  });

  it("NUNCA devuelve el valor de una variable", () => {
    const secreto = "gsk_esto_no_puede_salir_nunca_1234567890";
    soloCon({
      DATABASE_URL: "postgres://usuario:clave-secreta@host/base",
      JWT_SECRET: "otro-secreto-larguisimo",
      GROQ_API_KEY: secreto,
      GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
    });

    const serializado = JSON.stringify(buildEnvReport());

    expect(serializado).not.toContain(secreto);
    expect(serializado).not.toContain("clave-secreta");
    expect(serializado).not.toContain("otro-secreto-larguisimo");
    expect(serializado).not.toContain("abcd efgh");
  });

  it("informa los modos, que no son secretos y explican el comportamiento", () => {
    soloCon({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "s",
      IDENTITY_REVIEW_MODE: "manual",
    });

    const reporte = buildEnvReport();

    expect(reporte.modes.IDENTITY_REVIEW_MODE).toBe("manual");
    // Los que no están cargados dicen cuál es el valor por defecto.
    expect(reporte.modes.PAYMENTS_PROVIDER).toContain("defecto");
  });

  it("con todo cargado, allSet es true y no falta nada", () => {
    soloCon({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "s",
      GROQ_API_KEY: "gsk_x",
      GMAIL_USER: "a@b.com",
      GMAIL_APP_PASSWORD: "p",
      CLOUDINARY_CLOUD_NAME: "c",
      CLOUDINARY_API_KEY: "k",
      CLOUDINARY_API_SECRET: "s",
      FRONTEND_URL: "https://freewheel-5a.vercel.app",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "sec",
    });

    const reporte = buildEnvReport();

    expect(reporte.allSet).toBe(true);
    expect(reporte.missing).toEqual([]);
    expect(reporte.impact).toEqual([]);
  });
});
