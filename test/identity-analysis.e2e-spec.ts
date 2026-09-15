import type { INestApplication } from "@nestjs/common";
import { createHash } from "crypto";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  cuilFor,
  registerUser,
  setIdentityProfile,
  uniqueDni,
} from "./helpers/factory";
import {
  documentUrls,
  FakeCloudinaryService,
} from "./helpers/cloudinary.fake";

/**
 * LA VERIFICACIÓN AUTOMÁTICA, DE PUNTA A PUNTA.
 *
 * Lo que se ejercita acá es el camino que recorre un documento desde que la API
 * de lectura avisa que terminó hasta que la cuenta queda verificada (o no): el
 * cruce contra los datos del perfil, el veredicto, lo que se guarda de lo
 * extraído, y si esa persona puede alquilar un auto.
 *
 * ── Por qué el análisis se simula y no se llama de verdad ────────────────────
 * Leer un documento son ~10 segundos de OCR sobre fotos reales que no están en
 * el repo. Meter eso en la suite la haría lenta, la ataría a un servicio
 * externo y —lo peor— haría que los casos interesantes fueran imposibles de
 * armar: no hay forma de pedirle a un OCR que devuelva un apellido que no
 * coincide con el código de barras. Acá la lectura se escribe a mano, con la
 * forma EXACTA del contrato, y así cada situación se puede construir.
 *
 * Que la API de verdad devuelva esa forma lo cubren sus propias pruebas; que
 * este backend decida bien a partir de ella, lo cubre esto.
 */
describe("Verificación automática de documentos", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary } = await createTestApp({
      withStorageEnv: true,
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
  });

  const PERFIL = {
    firstName: "EMILIANO",
    lastName: "TEJADA ARAGON",
    dateOfBirth: "2000-04-06",
  };

  /** Una cuenta lista para enviar documentos, con su perfil completo. */
  async function cuenta(): Promise<{
    token: string;
    id: string;
    dni: string;
    cuil: string;
  }> {
    // `verified: false` deja la cuenta con el email verificado y nada más, que
    // es el punto de partida real de alguien que va a subir sus documentos.
    const user = await registerUser(app, {
      verified: false,
      firstName: PERFIL.firstName,
      lastName: PERFIL.lastName,
      dateOfBirth: PERFIL.dateOfBirth,
    });
    const dni = uniqueDni();
    const { cuil } = await setIdentityProfile(app, user.token, {
      dni,
      cuil: cuilFor(dni),
    });
    return { token: user.token, id: user.id, dni, cuil };
  }

  /**
   * Envía un documento y deja su fila lista para recibir el aviso del análisis.
   *
   * El submit intenta pedir el análisis y no puede —esta suite corre sin
   * DOCVERIFY_URL—, así que borra el token. Se escribe uno conocido a mano para
   * poder llamar al callback como lo haría la API de lectura: es la única forma
   * de ejercitar ese endpoint, porque el token real no sale nunca del servidor.
   */
  async function enviarYPrepararAviso(
    user: { token: string; id: string },
    kind: "dni" | "license",
  ): Promise<string> {
    await http()
      .post(`/verification/identity/${kind}/submit`)
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, kind))
      .expect(201);

    const token = `token-de-prueba-${kind}-${user.id}`;
    await prisma.documentVerification.updateMany({
      where: { userId: user.id, type: kind === "dni" ? "DNI" : "LICENSE" },
      data: {
        analysisStatus: "QUEUED",
        analysisRequestedAt: new Date(),
        analysisTokenHash: createHash("sha256").update(token).digest("hex"),
      },
    });
    return token;
  }

  const avisar = (token: string, resultado: unknown) =>
    http()
      .post("/verification/identity/analysis-callback")
      .set("Authorization", `Bearer ${token}`)
      .send({ referencia: "r", resultado });

  /** Un campo con la forma del contrato de la API de lectura. */
  const campo = (valor: string) => ({ valor, crudo: valor, confianza: 0.97 });

  /** Arma un resultado desde `{ "frente.ocr": { apellido: "X" } }`. */
  function lectura(
    porOrigen: Record<string, Record<string, string>>,
  ): Record<string, unknown> {
    const caras: Record<string, unknown> = {};
    for (const [ruta, campos] of Object.entries(porOrigen)) {
      const [cara, origen] = ruta.split(".");
      const sobre = (caras[cara] ??= {
        ok: true,
        documento: cara,
        origenes: {},
      }) as { origenes: Record<string, unknown> };
      sobre.origenes[origen] = {
        ok: true,
        disponible: true,
        error: "",
        campos: Object.fromEntries(
          Object.entries(campos).map(([n, v]) => [n, campo(v)]),
        ),
      };
    }
    return { ok: true, documento: "dni", version: "2.0.0", ms: 9432, caras };
  }

  const dniQueCierra = (dni: string, cuil: string) =>
    lectura({
      "frente.ocr": {
        apellido: PERFIL.lastName,
        nombre: PERFIL.firstName,
        sexo: "M",
        numero_documento: dni,
        fecha_nacimiento: PERFIL.dateOfBirth,
        fecha_vencimiento: "2039-04-06",
      },
      "frente.pdf417": {
        apellido: PERFIL.lastName,
        nombre: PERFIL.firstName,
        numero_documento: dni,
        fecha_nacimiento: PERFIL.dateOfBirth,
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "ARG",
        apellido: PERFIL.lastName,
        nombre: PERFIL.firstName,
        numero_documento: dni,
        fecha_nacimiento: PERFIL.dateOfBirth,
      },
      "dorso.ocr": { cuil },
    });

  const licenciaQueCierra = (dni: string, extra: Record<string, string> = {}) =>
    lectura({
      "frente.ocr": {
        apellido: PERFIL.lastName,
        nombre: PERFIL.firstName,
        numero_licencia: dni,
        numero_documento: dni,
        fecha_nacimiento: PERFIL.dateOfBirth,
        fecha_vencimiento: "2039-10-28",
        fecha_otorgamiento: "2020-10-28",
        clase: "B.1",
        ...extra,
      },
    });

  // ── El camino feliz ────────────────────────────────────────────────────

  it("aprueba el documento sin que intervenga nadie cuando todo cruza", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "dni");

    const res = await avisar(token, dniQueCierra(user.dni, user.cuil)).expect(
      201,
    );
    expect(res.body).toEqual({ applied: true, status: "APPROVED" });

    const fila = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: user.id, type: "DNI" },
    });
    expect(fila.status).toBe("APPROVED");
    expect(fila.analysisStatus).toBe("DONE");
    expect(fila.reasonCodes).toEqual([]);
    // El número que se guarda es el que dice el DOCUMENTO, no el declarado: el
    // declarado lo elige el usuario y es lo que el antifraude tiene que cruzar.
    expect(fila.documentNumber).toBe(user.dni);
    // El vencimiento leído queda guardado.
    expect(fila.expiresAt?.toISOString().slice(0, 10)).toBe("2039-04-06");
    // Y el token se consumió: el aviso vale una sola vez.
    expect(fila.analysisTokenHash).toBeNull();
  });

  it("guarda de la licencia lo que el formulario nunca preguntó", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "license");

    await avisar(token, licenciaQueCierra(user.dni)).expect(201);

    const perfil = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(perfil.licenseExpiresAt?.toISOString().slice(0, 10)).toBe(
      "2039-10-28",
    );
    expect(perfil.licenseClass).toBe("B.1");
    expect(perfil.licenseIssuedAt?.toISOString().slice(0, 10)).toBe(
      "2020-10-28",
    );
  });

  it("verifica la cuenta cuando los DOS documentos quedan aprobados", async () => {
    const user = await cuenta();

    await avisar(
      await enviarYPrepararAviso(user, "dni"),
      dniQueCierra(user.dni, user.cuil),
    ).expect(201);

    const parcial = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(parcial.body.fullyVerified).toBe(false);

    await avisar(
      await enviarYPrepararAviso(user, "license"),
      licenciaQueCierra(user.dni),
    ).expect(201);

    const final = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(final.body.verificationStatus).toBe("VERIFIED");
    expect(final.body.fullyVerified).toBe(true);
    // Y con la licencia vigente y clase B, puede alquilar.
    expect(final.body.driving.canRent).toBe(true);
    expect(final.body.driving.reasons).toEqual([]);
  });

  // ── Lo que NO se aprueba solo ──────────────────────────────────────────

  it("manda a revisión manual una tarjeta donde el texto y el código se contradicen", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "dni");

    const adulterado = dniQueCierra(user.dni, user.cuil) as {
      caras: Record<string, { origenes: Record<string, { campos: Record<string, unknown> }> }>;
    };
    adulterado.caras.frente.origenes.pdf417.campos.fecha_nacimiento =
      campo("2011-04-06");

    const res = await avisar(token, adulterado).expect(201);
    expect(res.body.status).toBe("PENDING");

    const fila = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: user.id, type: "DNI" },
    });
    expect(fila.reasonCodes).toContain("DATO_NO_COINCIDE_ENTRE_ORIGENES");

    // El motivo le llega al usuario en castellano, no como un código pelado.
    const mio = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(mio.body.dni.reasons[0].message).toContain("no dice lo mismo");
  });

  it("manda a revisión manual el documento de otra persona", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "dni");

    const deOtro = dniQueCierra("30111222", cuilFor("30111222"));
    const res = await avisar(token, deOtro).expect(201);

    expect(res.body.status).toBe("PENDING");
    const fila = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: user.id, type: "DNI" },
    });
    expect(fila.reasonCodes).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("nunca rechaza solo: ni con todo mal el veredicto es REJECTED", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "dni");

    const res = await avisar(
      token,
      lectura({
        "frente.ocr": { apellido: "GOMEZ", numero_documento: "11111111" },
        "frente.pdf417": { apellido: "PEREZ", numero_documento: "22222222" },
      }),
    ).expect(201);

    // Un OCR equivocándose no puede ser la última palabra sobre la identidad
    // de alguien: lo peor que puede pasar es que lo mire una persona.
    expect(res.body.status).toBe("PENDING");
    expect(res.body.status).not.toBe("REJECTED");
  });

  // ── Habilitación para conducir ─────────────────────────────────────────

  it("aprueba la licencia vencida pero no deja alquilar, y dice por qué", async () => {
    const user = await cuenta();
    await avisar(
      await enviarYPrepararAviso(user, "dni"),
      dniQueCierra(user.dni, user.cuil),
    ).expect(201);
    // Vencida: no se aprueba sola, la mira un admin. Se aprueba a mano para
    // llegar al estado que interesa —cuenta verificada, licencia vencida— que
    // es el de alguien que se verificó hace años.
    await avisar(
      await enviarYPrepararAviso(user, "license"),
      licenciaQueCierra(user.dni, { fecha_vencimiento: "2021-01-01" }),
    ).expect(201);
    await prisma.documentVerification.updateMany({
      where: { userId: user.id, type: "LICENSE" },
      data: { status: "APPROVED" },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { licenseExpiresAt: new Date("2021-01-01T12:00:00.000Z") },
    });

    const estado = await http()
      .get("/verification/me/status")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(estado.body.verificationStatus).toBe("VERIFIED");
    expect(estado.body.driving.canRent).toBe(false);
    expect(estado.body.driving.reasons[0].code).toBe("LICENCIA_VENCIDA");
    expect(estado.body.driving.reasons[0].message).toContain("1/1/2021");

    // Y el mismo aviso viaja en los datos de la cuenta, que es la llamada que
    // el front hace al abrir la aplicación.
    const yo = await http()
      .get("/users/me")
      .set("Authorization", auth(user.token))
      .expect(200);
    expect(yo.body.driving.canRent).toBe(false);
  });

  it("con la licencia vencida, pedir un auto devuelve 403 con el motivo", async () => {
    const user = await cuenta();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: "VERIFIED",
        licenseExpiresAt: new Date("2021-01-01T12:00:00.000Z"),
        licenseClass: "B.1",
      },
    });

    const res = await http()
      .post("/bookings")
      .set("Authorization", auth(user.token))
      .send({
        listingId: "00000000-0000-0000-0000-000000000000",
        startDate: "2030-01-01",
        endDate: "2030-01-05",
      })
      .expect(403);

    expect(res.body.code).toBe("DRIVING_NOT_ALLOWED");
    expect(res.body.reasons[0].code).toBe("LICENCIA_VENCIDA");
    // El mensaje alcanza para saber qué hacer sin preguntarle a nadie.
    expect(res.body.message).toContain("licencia");
  });

  it("una licencia de moto tampoco habilita a alquilar un auto", async () => {
    const user = await cuenta();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationStatus: "VERIFIED",
        licenseExpiresAt: new Date("2039-01-01T12:00:00.000Z"),
        licenseClass: "A2.2",
      },
    });

    const res = await http()
      .post("/bookings")
      .set("Authorization", auth(user.token))
      .send({
        listingId: "00000000-0000-0000-0000-000000000000",
        startDate: "2030-01-01",
        endDate: "2030-01-05",
      })
      .expect(403);

    expect(res.body.reasons[0].code).toBe("LICENCIA_CLASE_NO_HABILITA");
  });

  // ── El aviso, como endpoint público ────────────────────────────────────

  it("rechaza un aviso sin token y uno con token equivocado", async () => {
    const user = await cuenta();
    await enviarYPrepararAviso(user, "dni");

    const sinToken = await http()
      .post("/verification/identity/analysis-callback")
      .send({ resultado: {} })
      .expect(401);
    expect(sinToken.body.code).toBe("ANALYSIS_TOKEN_MISSING");

    const otro = await avisar("un-token-cualquiera", {}).expect(401);
    expect(otro.body.code).toBe("ANALYSIS_TOKEN_INVALID");
  });

  it("el aviso vale una sola vez", async () => {
    const user = await cuenta();
    const token = await enviarYPrepararAviso(user, "dni");

    await avisar(token, dniQueCierra(user.dni, user.cuil)).expect(201);
    // El segundo no encuentra a quién aplicarse. Es lo que hace que un aviso
    // repetido —o uno viejo, de fotos que ya se reemplazaron— no pueda pisar
    // un veredicto.
    await avisar(token, dniQueCierra(user.dni, user.cuil)).expect(401);
  });

  it("descarta el aviso de un análisis cuyas fotos ya se reemplazaron", async () => {
    const user = await cuenta();
    const viejo = await enviarYPrepararAviso(user, "dni");

    // El usuario reenvía fotos mientras el análisis anterior corría: ese
    // análisis ya no describe lo que hay guardado.
    await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(user.token))
      .send(documentUrls(user.id, "dni"))
      .expect(201);

    await avisar(viejo, dniQueCierra(user.dni, user.cuil)).expect(401);
  });
});
