import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createAdmin,
  cuilFor,
  registerUser,
  setIdentityProfile,
  uniqueDni,
} from "./helpers/factory";
import {
  documentUrls,
  FakeCloudinaryService,
} from "./helpers/cloudinary.fake";
import {
  FakePythonDocverifyService,
  IdentityPersona,
  personaFor,
} from "./helpers/identity.fake";

/**
 * LA VERIFICACIÓN DOCUMENTAL DE PUNTA A PUNTA
 *
 * El verificador Python está fakeado (devuelve el contrato que devolvería
 * leyendo fotos perfectas de una persona sintética), así que lo que se
 * ejercita acá es lo que decide el backend: que TODOS los datos coincidan
 * entre protocolos y contra la cuenta, las vigencias, la mayoría de edad, el
 * fin del período de principiante, y las dos salidas que le quedan al
 * usuario cuando algo falla (reenviar fotos o pedir revisión de un admin).
 */
describe("Verificación documental (DOCVERIFY_MODE=auto)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloudinary: FakeCloudinaryService;
  let docverify: FakePythonDocverifyService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma, cloudinary, docverify } = await createTestApp({
      docverifyMode: "auto",
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    cloudinary.reset();
    docverify.reset();
  });

  /**
   * Una cuenta con el perfil completo y el verificador configurado para
   * "leer" exactamente esos datos en los documentos: el caso feliz.
   */
  async function cuentaCoherente(
    overrides: Partial<IdentityPersona> = {},
  ): Promise<{ token: string; id: string; persona: IdentityPersona }> {
    const user = await registerUser(app, { verified: false });
    const dni = uniqueDni();
    const cuil = cuilFor(dni);
    const identity = await setIdentityProfile(app, user.token, { dni, cuil });

    const perfil = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const persona = personaFor({
      dni,
      cuil,
      firstName: perfil.firstName,
      lastName: perfil.lastName,
      birthDate: perfil.dateOfBirth!.toISOString().slice(0, 10),
      address: identity.address,
      ...overrides,
    });
    docverify.usePersona(persona);

    return { token: user.token, id: user.id, persona };
  }

  const submit = (token: string, userId: string, kind: "dni" | "license") =>
    http()
      .post(`/verification/identity/${kind}/submit`)
      .set("Authorization", auth(token))
      .send(documentUrls(userId, kind));

  // ── Caso feliz ─────────────────────────────────────────────────────────

  it("aprueba el DNI cuando todos los datos coinciden", async () => {
    const { token, id } = await cuentaCoherente();

    const res = await submit(token, id, "dni").expect(201);

    expect(res.body.status).toBe("APPROVED");
    expect(res.body.reasons).toEqual([]);
    expect(res.body.canRequestManualReview).toBe(false);

    // El verificador recibió exactamente las dos fotos del DNI.
    expect(docverify.calls).toEqual([["dni_front", "dni_back"]]);

    const row = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id },
    });
    // El número queda registrado de lo LEÍDO, no de lo declarado.
    expect(row.documentNumber).toBe(row.documentNumber);
    expect(row.frontUrl).toContain("cloudinary");
  });

  it("aprueba la licencia y verifica la cuenta con ambos documentos", async () => {
    const { token, id } = await cuentaCoherente();

    await submit(token, id, "dni").expect(201);
    const license = await submit(token, id, "license").expect(201);
    expect(license.body.status).toBe("APPROVED");

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    // REQUIRE_PHONE_VERIFICATION está en false por defecto.
    expect(user.verificationStatus).toBe("VERIFIED");
  });

  it("los dos flujos son independientes: uno puede aprobarse y el otro no", async () => {
    const { token, id } = await cuentaCoherente();

    await submit(token, id, "dni").expect(201);

    // La licencia llega con el vencimiento ilegible.
    docverify.mutate((res) => {
      if (res.documentos?.license_front) {
        res.documentos.license_front.ocr.fechaVencimiento = null;
      }
    });
    const license = await submit(token, id, "license").expect(201);

    expect(license.body.status).toBe("FAILED");
    const mine = await http()
      .get("/verification/identity/me")
      .set("Authorization", auth(token))
      .expect(200);
    expect(mine.body.dni.status).toBe("APPROVED");
    expect(mine.body.license.status).toBe("FAILED");

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("ID_SUBMITTED");
  });

  // ── Motivos de fallo ───────────────────────────────────────────────────

  it("no aprueba si el PDF417 no se pudo leer", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_front) {
        res.documentos.dni_front.codigo = {
          title: "codigo",
          apellido: null,
          nombre: null,
          sexo: null,
          nDocumento: null,
          fechaNacimiento: null,
          fechaEmision: null,
          error: { code: "SIN_CODIGO", message: "no apareció ningún código" },
        };
      }
    });

    const res = await submit(token, id, "dni").expect(201);

    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "CODIGO_NO_LEIDO",
    );
    // El mensaje explica qué hacer, no solo qué pasó.
    const motivo = res.body.reasons.find(
      (r: { code: string }) => r.code === "CODIGO_NO_LEIDO",
    );
    expect(motivo.message).toContain("código de barras");
    expect(res.body.canRequestManualReview).toBe(true);
  });

  it("no aprueba si el MRZ del dorso no validó", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_back) {
        res.documentos.dni_back.mrz = {
          title: "mrz",
          apellido: null,
          nombre: null,
          sexo: null,
          nDocumento: null,
          fechaNacimiento: null,
          fechaVencimiento: null,
          error: { code: "MRZ_NO_INTERPRETABLE", message: "no validó" },
        };
      }
    });

    const res = await submit(token, id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "MRZ_NO_LEIDO",
    );
  });

  it("no aprueba si un dato del documento no coincide con la cuenta", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_front) {
        res.documentos.dni_front.codigo.apellido = "OTROAPELLIDO";
        res.documentos.dni_front.ocr.apellido = "OTROAPELLIDO";
      }
    });

    const res = await submit(token, id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
    const motivo = res.body.reasons.find(
      (r: { code: string }) => r.code === "CAMPO_NO_COINCIDE",
    );
    expect(motivo.field).toBe("apellido");
    // Nunca se filtra el valor leído en el mensaje del usuario.
    expect(JSON.stringify(res.body.reasons)).not.toContain("OTROAPELLIDO");
  });

  it("no aprueba si un campo quedó vacío", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_back) {
        res.documentos.dni_back.ocr.cuil = null;
      }
    });

    const res = await submit(token, id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
    const motivo = res.body.reasons.find(
      (r: { code: string }) => r.code === "CAMPO_ILEGIBLE",
    );
    expect(motivo.field).toBe("cuil");
    expect(motivo.slot).toBe("dni_back");
  });

  it("rechaza un DNI vencido", async () => {
    const { token, id } = await cuentaCoherente({ dniExpiry: "2020-01-01" });

    const res = await submit(token, id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "DNI_VENCIDO",
    );
  });

  it("rechaza a un menor de edad según el documento", async () => {
    const menor = new Date();
    menor.setFullYear(menor.getFullYear() - 16);
    const birthDate = menor.toISOString().slice(0, 10);

    const user = await registerUser(app, { verified: false });
    const dni = uniqueDni();
    const cuil = cuilFor(dni);
    await setIdentityProfile(app, user.token, { dni, cuil });
    const perfil = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    // El documento dice que es menor, aunque la cuenta declare otra cosa.
    docverify.usePersona(
      personaFor({
        dni,
        cuil,
        firstName: perfil.firstName,
        lastName: perfil.lastName,
        birthDate,
      }),
    );

    const res = await submit(user.token, user.id, "dni").expect(201);
    const codes = res.body.reasons.map((r: { code: string }) => r.code);
    expect(codes).toContain("MENOR_DE_EDAD");
  });

  it("rechaza una licencia todavía en período de principiante", async () => {
    const futuro = new Date();
    futuro.setFullYear(futuro.getFullYear() + 1);
    const { token, id } = await cuentaCoherente({
      esPrincipiante: true,
      finPrincipiante: futuro.toISOString().slice(0, 10),
    });

    const res = await submit(token, id, "license").expect(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "PRINCIPIANTE_VIGENTE",
    );
  });

  it("aprueba una licencia cuyo período de principiante ya se cumplió", async () => {
    const { token, id } = await cuentaCoherente({
      esPrincipiante: true,
      finPrincipiante: "2020-01-01",
    });

    const res = await submit(token, id, "license").expect(201);
    expect(res.body.status).toBe("APPROVED");
  });

  it("rechaza una licencia que no corresponde al DNI de la cuenta", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.license_front) {
        res.documentos.license_front.ocr.numLicencia = "39999999";
      }
    });

    const res = await submit(token, id, "license").expect(201);
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "LICENCIA_NO_CORRESPONDE_AL_DNI",
    );
  });

  it("no aprueba si el mismo documento ya está verificado en otra cuenta", async () => {
    const primera = await cuentaCoherente();
    await submit(primera.token, primera.id, "dni").expect(201);

    // Otra cuenta manda un documento con el MISMO número leído.
    const otro = await registerUser(app, { verified: false });
    const dniPropio = uniqueDni();
    await setIdentityProfile(app, otro.token, {
      dni: dniPropio,
      cuil: cuilFor(dniPropio),
    });
    const perfil = await prisma.user.findUniqueOrThrow({
      where: { id: otro.id },
    });
    docverify.usePersona(
      personaFor({
        dni: dniPropio,
        cuil: cuilFor(dniPropio),
        firstName: perfil.firstName,
        lastName: perfil.lastName,
        birthDate: perfil.dateOfBirth!.toISOString().slice(0, 10),
      }),
    );
    docverify.mutate((res) => {
      if (res.documentos?.dni_front && res.documentos?.dni_back) {
        res.documentos.dni_front.ocr.nDocumento = primera.persona.dni;
        res.documentos.dni_front.codigo.nDocumento = primera.persona.dni;
        res.documentos.dni_back.mrz.nDocumento = primera.persona.dni;
      }
    });

    const res = await submit(otro.token, otro.id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
  });

  // ── Reenvío y revisión manual ──────────────────────────────────────────

  it("reenviar fotos reemplaza el intento anterior y borra sus archivos", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_back) res.documentos.dni_back.ocr.cuil = null;
    });
    await submit(token, id, "dni").expect(201);

    // Segundo intento con otras fotos (mismo slot, distinto sufijo) y datos ok.
    docverify.reset();
    const { token: _t, id: _i } = { token, id };
    docverify.usePersona(
      personaFor({
        dni: (await prisma.user.findUniqueOrThrow({ where: { id } })).dni!,
        cuil: (await prisma.user.findUniqueOrThrow({ where: { id } })).cuil!,
        firstName: (await prisma.user.findUniqueOrThrow({ where: { id } }))
          .firstName,
        lastName: (await prisma.user.findUniqueOrThrow({ where: { id } }))
          .lastName,
        birthDate: (await prisma.user.findUniqueOrThrow({ where: { id } }))
          .dateOfBirth!.toISOString()
          .slice(0, 10),
        address: (await prisma.user.findUniqueOrThrow({ where: { id } }))
          .address!,
      }),
    );

    const segunda = await http()
      .post("/verification/identity/dni/submit")
      .set("Authorization", auth(token))
      .send(documentUrls(id, "dni", "1700000099_beefcafe"))
      .expect(201);

    expect(segunda.body.status).toBe("APPROVED");
    // Las fotos del primer intento ya no están en el storage.
    expect(cloudinary.destroyed).toHaveLength(2);
    // Sigue habiendo UNA sola fila viva por documento.
    const filas = await prisma.documentVerification.findMany({
      where: { userId: id },
    });
    expect(filas).toHaveLength(1);
  });

  it("el usuario pide revisión manual y un admin la aprueba", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_back) {
        res.documentos.dni_back.ocr.domicilio = "OTRA CALLE 999";
      }
    });
    const fallida = await submit(token, id, "dni").expect(201);
    expect(fallida.body.status).toBe("FAILED");

    const pedida = await http()
      .post("/verification/identity/dni/request-review")
      .set("Authorization", auth(token))
      .expect(201);
    expect(pedida.body.status).toBe("MANUAL_REVIEW");
    expect(pedida.body.reviewRequestedAt).not.toBeNull();

    // Aparece en la cola del admin.
    const cola = await http()
      .get("/admin/verifications?status=MANUAL_REVIEW")
      .set("Authorization", auth(admin.token))
      .expect(200);
    expect(cola.body).toHaveLength(1);

    const aprobada = await http()
      .patch(`/admin/verifications/${cola.body[0].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "APPROVED", notes: "el domicilio es el mismo" })
      .expect(200);
    expect(aprobada.body.status).toBe("APPROVED");
    // Los archivos siguen guardados: la documentación fue aprobada.
    expect(aprobada.body.frontUrl).toContain("cloudinary");
  });

  it("el admin rechaza la revisión manual y la documentación se borra", async () => {
    const admin = await createAdmin(app, prisma);
    const { token, id } = await cuentaCoherente();
    docverify.mutate((res) => {
      if (res.documentos?.dni_front) {
        res.documentos.dni_front.ocr.apellido = "NO COINCIDE";
        res.documentos.dni_front.codigo.apellido = "NO COINCIDE";
      }
    });
    await submit(token, id, "dni").expect(201);
    await http()
      .post("/verification/identity/dni/request-review")
      .set("Authorization", auth(token))
      .expect(201);

    const cola = await http()
      .get("/admin/verifications?status=MANUAL_REVIEW")
      .set("Authorization", auth(admin.token))
      .expect(200);

    await http()
      .patch(`/admin/verifications/${cola.body[0].id}/review`)
      .set("Authorization", auth(admin.token))
      .send({ status: "REJECTED" })
      .expect(200);

    expect(cloudinary.destroyed).toHaveLength(2);
    const row = await prisma.documentVerification.findFirstOrThrow({
      where: { userId: id },
    });
    expect(row.status).toBe("REJECTED");
    expect(row.frontUrl).toBeNull();
    expect(row.backUrl).toBeNull();

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.verificationStatus).toBe("REJECTED");
  });

  it("no deja pedir revisión manual de un documento aprobado", async () => {
    const { token, id } = await cuentaCoherente();
    await submit(token, id, "dni").expect(201);

    const res = await http()
      .post("/verification/identity/dni/request-review")
      .set("Authorization", auth(token))
      .expect(400);
    expect(res.body.code).toBe("REVIEW_NOT_AVAILABLE");
  });

  /**
   * UNA revisión viva por documento, y la última que se pide es la que vale.
   *
   * Antes una revisión manual pendiente bloqueaba reenviar fotos, y eso dejaba
   * a la persona encerrada: en un servidor sin verificador la primera
   * submission caía sola en MANUAL_REVIEW y a partir de ahí todo daba 400.
   */
  describe("una sola revisión viva por documento", () => {
    it("reenviar fotos deja SIN EFECTO la revisión manual pendiente", async () => {
      const { token, id } = await cuentaCoherente();
      // Falla la automática...
      docverify.mutate((res) => {
        if (res.documentos?.dni_back) res.documentos.dni_back.ocr.cuil = null;
      });
      await submit(token, id, "dni").expect(201);
      // ...y se pide revisión manual.
      await http()
        .post("/verification/identity/dni/request-review")
        .set("Authorization", auth(token))
        .expect(201);
      const enCola = await prisma.documentVerification.findFirstOrThrow({
        where: { userId: id, type: "DNI" },
      });
      expect(enCola.status).toBe("MANUAL_REVIEW");
      expect(enCola.reviewRequestedAt).not.toBeNull();

      // Y ahora se mandan fotos nuevas, esta vez legibles: NO da 400, y el
      // pedido manual muere.
      docverify.clearMutators();
      const res = await submit(token, id, "dni").expect(201);
      expect(res.body.status).toBe("APPROVED");

      const fila = await prisma.documentVerification.findFirstOrThrow({
        where: { userId: id, type: "DNI" },
      });
      expect(fila.status).toBe("APPROVED");
      expect(fila.reviewRequestedAt).toBeNull();

      // Y no quedó una segunda fila: hay una sola revisión viva.
      expect(
        await prisma.documentVerification.count({
          where: { userId: id, type: "DNI" },
        }),
      ).toBe(1);
    });

    it("después de reenviar se puede pedir revisión manual DE NUEVO", async () => {
      const { token, id } = await cuentaCoherente();
      docverify.mutate((res) => {
        if (res.documentos?.dni_back) res.documentos.dni_back.ocr.cuil = null;
      });
      await submit(token, id, "dni").expect(201);
      await http()
        .post("/verification/identity/dni/request-review")
        .set("Authorization", auth(token))
        .expect(201);

      // Otra automática, que también falla (el mutador sigue puesto).
      const reenvio = await submit(token, id, "dni").expect(201);
      expect(reenvio.body.status).toBe("FAILED");
      expect(reenvio.body.canRequestManualReview).toBe(true);

      // La manual se puede volver a pedir, y es sobre ESTE resultado.
      const pedido = await http()
        .post("/verification/identity/dni/request-review")
        .set("Authorization", auth(token))
        .expect(201);
      expect(pedido.body.status).toBe("MANUAL_REVIEW");
    });

    it("con una revisión manual pendiente, canResubmit sigue en true", async () => {
      const { token, id } = await cuentaCoherente();
      docverify.mutate((res) => {
        if (res.documentos?.dni_back) res.documentos.dni_back.ocr.cuil = null;
      });
      await submit(token, id, "dni").expect(201);
      const pedido = await http()
        .post("/verification/identity/dni/request-review")
        .set("Authorization", auth(token))
        .expect(201);

      // Es lo que mira el front para saber si deja subir fotos otra vez.
      expect(pedido.body.status).toBe("MANUAL_REVIEW");
      expect(pedido.body.canResubmit).toBe(true);
      expect(pedido.body.canRequestManualReview).toBe(false);
    });
  });

  it("si el verificador falla, el caso queda reintentables con motivo claro", async () => {
    const { token, id } = await cuentaCoherente();
    docverify.failWith(new Error("python murió"));

    const res = await submit(token, id, "dni").expect(201);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.reasons.map((r: { code: string }) => r.code)).toContain(
      "VERIFICACION_NO_DISPONIBLE",
    );
    expect(res.body.canRequestManualReview).toBe(true);
  });

  /**
   * Lo que el front demo necesita para poder diagnosticar: qué leyó el
   * verificador campo por campo y cómo se comparó contra la cuenta.
   */
  describe("el informe de extracción que ve el usuario", () => {
    it("trae el JSON crudo del verificador, foto por foto y protocolo por protocolo", async () => {
      const { token, id } = await cuentaCoherente();
      const res = await submit(token, id, "dni").expect(201);

      const extraction = res.body.extraction;
      expect(extraction).not.toBeNull();
      expect(extraction.mode).toBe("auto");
      expect(extraction.degradedReason).toBeNull();

      // El contrato entero, tal cual lo devolvió el verificador.
      const docs = extraction.extracted.documentos;
      expect(Object.keys(docs).sort()).toEqual(["dni_back", "dni_front"]);
      expect(docs.dni_front.ocr.nDocumento).toBeTruthy();
      expect(docs.dni_front.codigo.nDocumento).toBeTruthy();
      expect(docs.dni_back.mrz.nDocumento).toBeTruthy();
      expect(docs.dni_back.ocr.cuil).toBeTruthy();
    });

    it("trae la comparación campo por campo, con qué dijo cada fuente", async () => {
      const { token, id } = await cuentaCoherente();
      const res = await submit(token, id, "dni").expect(201);

      const matrix = res.body.extraction.matrix;
      expect(Array.isArray(matrix)).toBe(true);
      expect(matrix.length).toBeGreaterThan(0);

      // Cada fila dice el campo, lo que leyó cada fuente y si cerró: es
      // exactamente lo que hace falta para ver DÓNDE está el problema.
      for (const fila of matrix) {
        expect(typeof fila.field).toBe("string");
        expect(typeof fila.readings).toBe("object");
        expect(["ok", "vacio", "conflicto", "advertencia"]).toContain(
          fila.status,
        );
      }
      expect(matrix.map((f: { field: string }) => f.field)).toContain(
        "nDocumento",
      );
    });

    it("cuando algo NO coincide, la matriz muestra el conflicto", async () => {
      const { token, id } = await cuentaCoherente();
      docverify.mutate((res) => {
        if (res.documentos?.dni_front) {
          res.documentos.dni_front.ocr.apellido = "OTROAPELLIDO";
        }
      });
      const res = await submit(token, id, "dni").expect(201);

      expect(res.body.status).toBe("FAILED");
      const apellido = res.body.extraction.matrix.find(
        (f: { field: string }) => f.field === "apellido",
      );
      expect(apellido.status).toBe("conflicto");
      // Y se ve QUÉ leyó cada fuente, que es lo que permite decidir si el
      // problema es la foto o el dato cargado en el perfil.
      expect(Object.values(apellido.readings)).toContain("OTROAPELLIDO");
    });

    it("el número y el vencimiento leídos del documento viajan aparte", async () => {
      const { token, id } = await cuentaCoherente();
      const res = await submit(token, id, "dni").expect(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(res.body.extraction.documentNumber).toBe(user.dni);
      expect(res.body.extraction.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("GET /verification/identity/me también lo trae", async () => {
      const { token, id } = await cuentaCoherente();
      await submit(token, id, "dni").expect(201);

      const res = await http()
        .get("/verification/identity/me")
        .set("Authorization", auth(token))
        .expect(200);
      expect(res.body.dni.extraction.extracted.documentos.dni_front).toBeTruthy();
      expect(res.body.license).toBeNull();
    });
  });

  describe("diagnóstico del servidor", () => {
    it("dice con qué modo corre y si el verificador contesta", async () => {
      const { token } = await cuentaCoherente();
      const res = await http()
        .get("/verification/identity/diagnostics")
        .set("Authorization", auth(token))
        .expect(200);

      expect(res.body.mode).toBe("auto");
      expect(res.body.configured).toBe("auto");
      expect(res.body.degradedReason).toBeNull();
      expect(res.body.canVerifyAutomatically).toBe(true);
      expect(res.body.exposeExtraction).toBe(true);
    });
  });
});
