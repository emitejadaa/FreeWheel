import { User, VerifiedDocumentType } from "@prisma/client";
import { DocverifyResult } from "./docverify.client";
import { IdentityMatchService } from "./identity-match.service";

/**
 * Los casos que este archivo cuida son los que deciden si alguien entra o no a
 * la plataforma, así que están escritos como situaciones y no como "el método
 * X devuelve Y": una tarjeta adulterada, un documento de otra persona, una
 * foto con reflejo.
 */

const matcher = new IdentityMatchService();

/** La cuenta contra la que se cruza todo. */
const CUENTA = {
  id: "user-1",
  firstName: "EMILIANO",
  lastName: "TEJADA ARAGON",
  dni: "49380010",
  cuil: "20-49380010-9",
  dateOfBirth: new Date("2009-04-06T12:00:00.000Z"),
} as unknown as User;

/** Un campo leído, con la forma del contrato de la API. */
function campo(valor: string, confianza = 0.95) {
  return { valor, crudo: valor, confianza };
}

/**
 * Arma la respuesta de la API a partir de un mapa simple
 * `{ "frente.ocr": { apellido: "X" } }`, que es mucho más legible en un test
 * que el sobre completo anidado.
 */
function lectura(
  porOrigen: Record<string, Record<string, string | [string, number]>>,
): DocverifyResult {
  const caras: DocverifyResult["caras"] = {};
  for (const [ruta, campos] of Object.entries(porOrigen)) {
    const [cara, origen] = ruta.split(".");
    caras[cara] ??= { ok: true, documento: cara, origenes: {} };
    caras[cara].origenes![origen] = {
      ok: true,
      disponible: true,
      error: "",
      campos: Object.fromEntries(
        Object.entries(campos).map(([nombre, valor]) => [
          nombre,
          Array.isArray(valor) ? campo(valor[0], valor[1]) : campo(valor),
        ]),
      ),
    };
  }
  return {
    ok: true,
    documento: "dni",
    version: "2.0.0",
    ms: 4200,
    caras,
    coincidencias: {},
  };
}

/** Un DNI que cierra por todos lados: la línea de base de los tests. */
const DNI_PERFECTO = lectura({
  "frente.ocr": {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    sexo: "M",
    numero_documento: "49380010",
    fecha_nacimiento: "2009-04-06",
    fecha_vencimiento: "2039-04-06",
  },
  "frente.pdf417": {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    sexo: "M",
    numero_documento: "49380010",
    fecha_nacimiento: "2009-04-06",
  },
  "dorso.ocr": { cuil: "20-49380010-9", numero_documento: "49380010" },
  "dorso.mrz": {
    tipo_documento: "ID",
    pais_emisor: "ARG",
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    sexo: "M",
    numero_documento: "49380010",
    fecha_nacimiento: "2009-04-06",
    fecha_vencimiento: "2039-04-06",
  },
});

const codigos = (r: { reasons: { code: string }[] }) =>
  r.reasons.map((motivo) => motivo.code);

describe("IdentityMatchService · DNI", () => {
  it("aprueba solo cuando todo cierra y todos los orígenes coinciden", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DNI_PERFECTO,
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    // El apellido lo leyeron tres fuentes independientes: eso es lo que hace
    // que aprobar signifique algo.
    expect(report.fields.apellido.sources).toEqual([
      "dorso.mrz",
      "frente.ocr",
      "frente.pdf417",
    ]);
    expect(report.fields.apellido.corroborated).toBe(true);
    expect(report.fields.apellido.matchesAccount).toBe(true);
  });

  it("detecta una tarjeta adulterada: el texto impreso dice una cosa y el código otra", () => {
    // Es EL caso que justifica leer el documento por todos los medios: quien
    // altera una tarjeta cambia lo que se ve, no lo que dice el PDF417.
    const adulterado = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "frente.pdf417": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        // El impreso fue retocado para aparentar mayoría de edad; el código
        // sigue diciendo la fecha original.
        fecha_nacimiento: "2011-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      adulterado,
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_ENTRE_ORIGENES");
    expect(report.fields.fecha_nacimiento.agrees).toBe(false);
    expect(report.fields.fecha_nacimiento.values).toHaveLength(2);
  });

  it("detecta el documento de otra persona", () => {
    const deOtro = lectura({
      "frente.ocr": {
        apellido: "GOMEZ",
        nombre: "LUCIA",
        numero_documento: "30111222",
        fecha_nacimiento: "1990-01-01",
      },
    });

    const report = matcher.evaluate(VerifiedDocumentType.DNI, deOtro, CUENTA);

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("no confunde tildes, mayúsculas ni puntos con un documento ajeno", () => {
    // Sin normalizar, cada uno de estos tres sería una revisión manual sobre
    // un documento perfecto.
    const conAcentos = lectura({
      "frente.ocr": {
        apellido: "Tejada Aragón",
        nombre: "  emiliano ",
        numero_documento: "49.380.010",
        fecha_nacimiento: "2009-04-06",
        fecha_vencimiento: "2039-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      conAcentos,
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.fields.apellido.matchesAccount).toBe(true);
    expect(report.fields.numero_documento.matchesAccount).toBe(true);
  });

  it("manda a revisión manual cuando falta un dato imprescindible", () => {
    const sinApellido = lectura({
      "frente.ocr": {
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      sinApellido,
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_ILEGIBLE");
    // Que no se pueda leer NO es que no coincida: son cosas distintas y el
    // mensaje que ve el usuario también.
    expect(codigos(report)).not.toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("rechaza un documento que la MRZ dice que no es argentino", () => {
    const extranjero = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "dorso.mrz": { tipo_documento: "ID", pais_emisor: "BRA" },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      extranjero,
      CUENTA,
    );

    expect(codigos(report)).toContain("DOCUMENTO_NO_ES_ARGENTINO");
  });

  it("detecta un CUIL que no corresponde al DNI", () => {
    const cuilAjeno = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      // Bien formado y con verificador válido, pero de otro número.
      "dorso.ocr": { cuil: "20-30111222-3" },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      cuilAjeno,
      CUENTA,
    );

    expect(codigos(report)).toContain("CUIL_NO_CORRESPONDE_AL_DNI");
  });

  it("nunca rechaza solo: el peor caso posible sigue siendo revisión manual", () => {
    // Todo mal a la vez. Aun así el veredicto no puede ser un rechazo: un OCR
    // equivocándose no puede ser la última palabra sobre la identidad de nadie.
    const desastre = lectura({
      "frente.ocr": { apellido: "GOMEZ", numero_documento: "11111111" },
      "frente.pdf417": { apellido: "PEREZ", numero_documento: "22222222" },
    });

    const report = matcher.evaluate(VerifiedDocumentType.DNI, desastre, CUENTA);

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(report.reasons.length).toBeGreaterThan(1);
  });

  it("no explota con un análisis vacío", () => {
    const vacio: DocverifyResult = {
      ok: false,
      documento: "dni",
      version: "2.0.0",
      ms: 0,
      caras: {},
      coincidencias: {},
    };

    const report = matcher.evaluate(VerifiedDocumentType.DNI, vacio, CUENTA);

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_ILEGIBLE");
  });
});

describe("IdentityMatchService · licencia", () => {
  const licenciaBase = {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    numero_documento: "49380010",
    numero_licencia: "49380010",
    fecha_nacimiento: "2009-04-06",
    fecha_vencimiento: "2039-10-28",
    fecha_otorgamiento: "2024-10-28",
    clase: "B.1",
  };

  it("aprueba y guarda lo que el formulario no tenía", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({ "frente.ocr": licenciaBase }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.facts.expiresAt?.toISOString().slice(0, 10)).toBe(
      "2039-10-28",
    );
    expect(report.facts.licenseClass).toBe("B.1");
    expect(report.facts.licenseIssuedAt?.toISOString().slice(0, 10)).toBe(
      "2024-10-28",
    );
  });

  it("detecta que la licencia es de otra persona que el DNI", () => {
    // En Argentina la licencia lleva el número de DNI del titular. Que no
    // coincida significa, casi siempre, que las fotos son de dos personas.
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": { ...licenciaBase, numero_licencia: "30111222" },
      }),
      CUENTA,
    );

    expect(codigos(report)).toContain("LICENCIA_NO_ES_DEL_TITULAR");
    expect(report.verdict).toBe("MANUAL_REVIEW");
  });

  it("aprueba igual una licencia de moto, pero deja anotado que no habilita", () => {
    // La licencia es genuinamente suya: sirve para verificar su identidad.
    // Lo que no hace es habilitarlo a alquilar un auto, y eso se resuelve en
    // el control de habilitación, no mandándosela a un admin.
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({ "frente.ocr": { ...licenciaBase, clase: "A2.2" } }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).toEqual(["LICENCIA_CLASE_NO_HABILITA"]);
    expect(report.facts.licenseClass).toBe("A2.2");
  });

  it("aprueba una licencia de principiante y guarda hasta cuándo lo es", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": licenciaBase,
        "dorso.ocr": {
          es_principiante: "true",
          fin_principiante: "2099-10-28",
          clase: "B.1",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).toEqual(["LICENCIA_PRINCIPIANTE"]);
    expect(report.facts.licenseBeginnerUntil?.toISOString().slice(0, 10)).toBe(
      "2099-10-28",
    );
  });

  it("no aprueba una licencia vencida: ahí sí mira una persona", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": { ...licenciaBase, fecha_vencimiento: "2020-01-01" },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DOCUMENTO_VENCIDO");
  });

  it("acepta las clases profesionales, que incluyen la de auto", () => {
    for (const clase of ["B", "B.1", "C.2", "D.1", "E.1"]) {
      const report = matcher.evaluate(
        VerifiedDocumentType.LICENSE,
        lectura({ "frente.ocr": { ...licenciaBase, clase } }),
        CUENTA,
      );
      expect(codigos(report)).not.toContain("LICENCIA_CLASE_NO_HABILITA");
    }
  });

  it("con desacuerdo se queda con la lectura de más confianza", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": { ...licenciaBase, apellido: ["TEJADA ARAGÓN", 0.4] },
        "dorso.pdf417": { apellido: ["TEJADA ARAGON", 1.0] },
      }),
      CUENTA,
    );

    // Normalizados son el mismo apellido, así que no hay desacuerdo…
    expect(report.fields.apellido.agrees).toBe(true);
    // …y el valor que se muestra es el que el motor leyó con más certeza.
    expect(report.fields.apellido.value).toBe("TEJADA ARAGON");
  });
});

/**
 * ─── Concesiones de la fase de prueba ────────────────────────────────────────
 *
 * Lo que sigue cubre dos aflojadas deliberadas. Están juntas y al final a
 * propósito: son lo primero que hay que borrar cuando la plataforma deje de
 * ser una demo. Los tests describen exactamente hasta dónde llega cada una,
 * así que borrarlos es la forma de comprobar que la aflojada se fue completa.
 */

/** El mismo DNI de siempre, con otro nombre de pila en los tres orígenes. */
const dniConNombre = (nombre: string) =>
  lectura({
    "frente.ocr": {
      apellido: "TEJADA ARAGON",
      nombre,
      sexo: "M",
      numero_documento: "49380010",
      fecha_nacimiento: "2009-04-06",
      fecha_vencimiento: "2039-04-06",
    },
    "frente.pdf417": {
      apellido: "TEJADA ARAGON",
      nombre,
      sexo: "M",
      numero_documento: "49380010",
      fecha_nacimiento: "2009-04-06",
    },
    "dorso.ocr": { cuil: "20-49380010-9", numero_documento: "49380010" },
    "dorso.mrz": {
      tipo_documento: "ID",
      pais_emisor: "ARG",
      apellido: "TEJADA ARAGON",
      nombre,
      sexo: "M",
      numero_documento: "49380010",
      fecha_nacimiento: "2009-04-06",
      fecha_vencimiento: "2039-04-06",
    },
  });

describe("IdentityMatchService · un error de lectura en el nombre", () => {
  it("aprueba un nombre con una sola letra mal leída", () => {
    // El caso real que motivó esto: el OCR lee EMITIANO donde dice EMILIANO.
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      dniConNombre("EMITIANO"),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.fields.nombre.matchesAccount).toBe(true);
  });

  it("no tolera dos letras: ahí ya puede ser otra persona", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      dniConNombre("EMITUANO"),
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("no afloja en el número de documento, donde una cifra es otro documento", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      lectura({
        "frente.ocr": {
          apellido: "TEJADA ARAGON",
          nombre: "EMILIANO",
          numero_documento: "49380011",
          fecha_nacimiento: "2009-04-06",
        },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });
});

describe("IdentityMatchService · la cuenta de prueba", () => {
  const CUENTA_DE_PRUEBA = {
    ...CUENTA,
    email: "demo@freewheel.test",
  } as unknown as User;

  /** Un DNI que es de otra persona: motivo de revisión para cualquiera. */
  const DOCUMENTO_AJENO = dniConNombre("RODOLFO");

  afterEach(() => {
    delete process.env.VERIFICACION_CUENTA_DE_PRUEBA;
  });

  it("aprueba un documento que a cualquier otra cuenta le costaría una revisión", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DOCUMENTO_AJENO,
      CUENTA_DE_PRUEBA,
    );

    expect(report.verdict).toBe("APPROVE");
  });

  it("conserva los motivos reales, para que se vea qué habría fallado", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "demo@freewheel.test";

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DOCUMENTO_AJENO,
      CUENTA_DE_PRUEBA,
    );

    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("sin la variable configurada no tiene ningún privilegio", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DOCUMENTO_AJENO,
      CUENTA_DE_PRUEBA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
  });

  it("el privilegio es de un mail, no de la fase de prueba", () => {
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "otra@freewheel.test";

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DOCUMENTO_AJENO,
      CUENTA_DE_PRUEBA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
  });

  it("compara el mail sin distinguir mayúsculas ni espacios de más", () => {
    // La variable la escribe una persona en un panel: va a tener un espacio
    // pegado o una mayúscula, y eso no puede ser la diferencia entre que
    // funcione y no.
    process.env.VERIFICACION_CUENTA_DE_PRUEBA = "  DEMO@FreeWheel.test  ";

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DOCUMENTO_AJENO,
      CUENTA_DE_PRUEBA,
    );

    expect(report.verdict).toBe("APPROVE");
  });
});
