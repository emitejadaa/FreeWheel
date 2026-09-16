/**
 * ⚠️ TEMPORAL — MODO DEMO APAGADO. Ver src/common/demo-mode.ts.
 *
 * Lo que este archivo describe son las reglas DE VERDAD, y tienen que seguir
 * cubiertas mientras el andamio del demo esté puesto: con el modo encendido
 * estos tests afirmarían lo contrario de lo que dicen. El modo se prueba
 * aparte, en demo-mode.spec.ts.
 *
 * Se escribe antes de los imports —y por eso va con `process.env` pelado y no
 * en un `beforeAll`— porque hay módulos que leen la variable al cargarse.
 */
process.env.VERIFICATION_DEMO_MODE = "false";

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
      "frente.pdf417": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
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

  it("da igual el formato en el que cada origen escriba el mismo dato", () => {
    // LO QUE ESTE TEST CUIDA: que la comparación mire el DATO y no el texto.
    // Cada origen escribe a su manera —el OCR copia los puntos del impreso, el
    // código trae el número pelado, las fechas llegan con barras o en ISO— y
    // tratar esas diferencias como desacuerdos mandaba a revisión manual
    // documentos que cierran perfecto.
    const mismosDatosOtroFormato = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49.380.010",
        fecha_nacimiento: "06/04/2009",
        sexo: "MASCULINO",
      },
      "frente.pdf417": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "049380010",
        fecha_nacimiento: "2009-04-06",
        sexo: "M",
      },
      "dorso.ocr": { cuil: "20493800109" },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      mismosDatosOtroFormato,
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    expect(report.fields.fecha_nacimiento.agrees).toBe(true);
    expect(report.fields.numero_documento.agrees).toBe(true);
    expect(report.fields.sexo.agrees).toBe(true);
    // El CUIL de la cuenta tiene guiones y el del documento no: mismo CUIL.
    expect(report.fields.cuil.matchesAccount).toBe(true);
  });

  it("acepta un nombre al que un origen le suma lo que el otro no trae", () => {
    // El formulario de la cuenta tiene un solo nombre de pila y el documento
    // trae los dos. Es una diferencia de formato del origen, no dos personas.
    const conSegundoNombre = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO JOSE",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "frente.pdf417": {
        apellido: "TEJADA",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      conSegundoNombre,
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.fields.nombre.matchesAccount).toBe(true);
    expect(report.fields.apellido.agrees).toBe(true);
  });

  it("sigue distinguiendo dos apellidos con las mismas partes al revés", () => {
    // La tolerancia de arriba no puede llegar tan lejos: "TEJADA ARAGON" y
    // "ARAGON TEJADA" son apellidos de personas distintas.
    const invertido = lectura({
      "frente.ocr": {
        apellido: "ARAGON TEJADA",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "frente.pdf417": { apellido: "ARAGON TEJADA" },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      invertido,
      CUENTA,
    );

    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("acepta el QR en lugar del PDF417: las emisiones nuevas lo traen así", () => {
    const conQr = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "frente.qr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
    });

    const report = matcher.evaluate(VerifiedDocumentType.DNI, conQr, CUENTA);

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).not.toContain("CODIGO_NO_LEIDO");
  });

  it("no aprueba un DNI del que no se pudo leer ni el PDF417 ni el QR", () => {
    // Sin código solo queda el texto impreso, que es justamente lo que retoca
    // quien falsifica una tarjeta: no hay contra qué cruzarlo.
    const soloImpreso = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "2009-04-06",
      },
      "dorso.mrz": { tipo_documento: "ID", pais_emisor: "ARG" },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      soloImpreso,
      CUENTA,
    );

    expect(report.verdict).toBe("MANUAL_REVIEW");
    expect(codigos(report)).toContain("CODIGO_NO_LEIDO");
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

  it("ignora el código del dorso, que lee mal y contradice al frente", () => {
    // EL CASO REAL: el PDF417 del dorso decodifica a medias y el código lineal
    // del borde no contiene el número de licencia. Mientras se los miraba,
    // cada licencia auténtica llegaba con un desacuerdo inventado encima.
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": licenciaBase,
        "dorso.pdf417": { apellido: "TEJADA A:60/N@H", numero_documento: "9" },
        "dorso.codigo_1d": { numero_licencia: "046909121" },
      }),
      CUENTA,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    // Y no aparecen entre las fuentes del informe: se descartan en la entrada.
    expect(report.fields.apellido.sources).toEqual(["frente.ocr"]);
  });

  it("no exige código en la licencia, justamente porque no se lee", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({ "frente.ocr": licenciaBase }),
      CUENTA,
    );

    expect(codigos(report)).not.toContain("CODIGO_NO_LEIDO");
  });

  it("no cree que la licencia sea de otro por los puntos del DNI impreso", () => {
    // El dorso trae el DNI con puntos y el frente el número de licencia
    // pelado: es el MISMO número, y compararlos crudos decía lo contrario.
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": { ...licenciaBase, numero_documento: "49.380.010" },
      }),
      CUENTA,
    );

    expect(codigos(report)).not.toContain("LICENCIA_NO_ES_DEL_TITULAR");
    expect(report.verdict).toBe("APPROVE");
  });

  it("con desacuerdo se queda con la lectura de más confianza", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      lectura({
        "frente.ocr": { ...licenciaBase, apellido: ["TEJADA ARAGÓN", 0.4] },
        "dorso.ocr": { apellido: ["TEJADA ARAGON", 1.0] },
      }),
      CUENTA,
    );

    // Normalizados son el mismo apellido, así que no hay desacuerdo…
    expect(report.fields.apellido.agrees).toBe(true);
    // …y el valor que se muestra es el que el motor leyó con más certeza.
    expect(report.fields.apellido.value).toBe("TEJADA ARAGON");
  });
});
