import { User, VerifiedDocumentType } from "@prisma/client";
import { DocverifyResult } from "./docverify.client";
import {
  DeclaredDocumentData,
  IdentityMatchService,
} from "./identity-match.service";

/**
 * Los casos que este archivo cuida son los que deciden si alguien entra o no a
 * la plataforma, así que están escritos como situaciones y no como "el método
 * X devuelve Y": una tarjeta adulterada, un documento de otra persona, una
 * fecha cargada mal, una foto con reflejo.
 *
 * La pregunta de fondo cambió con el rediseño y conviene tenerla presente
 * leyendo lo que sigue: ya no es "¿qué dice este documento?" sino "¿este
 * documento dice lo mismo que declaró su dueño?". Nada de lo que la máquina lee
 * se guarda.
 */

const matcher = new IdentityMatchService();

/** La cuenta contra la que se cruza todo. */
const CUENTA = {
  id: "user-1",
  firstName: "EMILIANO",
  lastName: "TEJADA ARAGON",
  dni: "49380010",
  cuil: "20-49380010-9",
  dateOfBirth: new Date("1998-04-06T12:00:00.000Z"),
} as unknown as User;

const dia = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/** Lo que el dueño del DNI declaró de su DNI. */
const DNI_DECLARADO: DeclaredDocumentData = {
  expiresAt: dia("2039-04-06"),
};

/** Lo que el dueño de la licencia declaró de su licencia. */
const LICENCIA_DECLARADA: DeclaredDocumentData = {
  expiresAt: dia("2032-08-15"),
  issuedAt: dia("2027-08-15"),
  licenseClass: "B.1",
  isBeginner: false,
  beginnerUntil: null,
};

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
    fecha_nacimiento: "1998-04-06",
    fecha_vencimiento: "2039-04-06",
  },
  "frente.pdf417": {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    sexo: "M",
    numero_documento: "49380010",
    fecha_nacimiento: "1998-04-06",
  },
  "dorso.ocr": { cuil: "20-49380010-9", numero_documento: "49380010" },
  "dorso.mrz": {
    tipo_documento: "ID",
    pais_emisor: "ARG",
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    sexo: "M",
    numero_documento: "49380010",
    fecha_nacimiento: "1998-04-06",
    fecha_vencimiento: "2039-04-06",
  },
});

/** Una licencia que cierra por todos lados. */
const LICENCIA_PERFECTA = lectura({
  "frente.ocr": {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    numero_licencia: "49380010",
    fecha_nacimiento: "1998-04-06",
    fecha_vencimiento: "2032-08-15",
    fecha_otorgamiento: "2027-08-15",
    clase: "B.1",
  },
  "dorso.pdf417": {
    apellido: "TEJADA ARAGON",
    nombre: "EMILIANO",
    numero_licencia: "49380010",
  },
});

const codigos = (r: { reasons: { code: string }[] }) =>
  r.reasons.map((motivo) => motivo.code);

/** El motivo con este código, para poder mirarle la foto y la acción. */
const motivo = (r: { reasons: { code: string }[] }, code: string) =>
  r.reasons.find((m) => m.code === code) as {
    code: string;
    action: string;
    slots: string[];
  };

// ──────────────────────────────────────────────────────────────────────────
describe("IdentityMatchService · DNI", () => {
  it("aprueba cuando todo cierra y todos los orígenes coinciden", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DNI_PERFECTO,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("APPROVE");
    expect(report.reasons).toEqual([]);
    expect(report.retakeSlots).toEqual([]);
  });

  it("NO guarda lo que leyó: el informe dice si coincidió, no qué decía", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DNI_PERFECTO,
      CUENTA,
      DNI_DECLARADO,
    );

    // Es el punto central del rediseño. Si algún día alguien agrega un `value`
    // acá, este test se cae y obliga a pensarlo de nuevo.
    const serializado = JSON.stringify(report.checks);
    expect(serializado).not.toContain("TEJADA");
    expect(serializado).not.toContain("49380010");
    expect(report.checks.apellido).toEqual({
      sources: 3,
      agrees: true,
      corroborated: true,
      matches: true,
      slots: ["dni_front", "dni_back"],
    });
  });

  it("falla y señala la foto cuando el impreso y el código no coinciden", () => {
    // La firma del fraude: alguien cambió lo que se ve y el código quedó
    // diciendo el dato original.
    const adulterado = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "ARG",
        apellido: "GOMEZ",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      adulterado,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_ENTRE_ORIGENES");
    // No se le pide que arregle nada: esto lo mira una persona.
    expect(motivo(report, "DATO_NO_COINCIDE_ENTRE_ORIGENES").action).toBe(
      "REQUEST_REVIEW",
    );
    expect(motivo(report, "DATO_NO_COINCIDE_ENTRE_ORIGENES").slots).toEqual([
      "dni_front",
      "dni_back",
    ]);
  });

  it("falla cuando el documento es de otra persona", () => {
    const deOtro = lectura({
      "frente.ocr": {
        apellido: "GOMEZ",
        nombre: "RODOLFO",
        numero_documento: "12345678",
        fecha_nacimiento: "1970-01-01",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "ARG",
        apellido: "GOMEZ",
        nombre: "RODOLFO",
        numero_documento: "12345678",
        fecha_nacimiento: "1970-01-01",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      deOtro,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
    expect(motivo(report, "DATO_NO_COINCIDE_CON_LA_CUENTA").action).toBe(
      "FIX_PROFILE",
    );
  });

  it("perdona UNA letra en el nombre: el OCR confunde L con T", () => {
    const conReflejo = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMITIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "ARG",
        apellido: "TEJADA ARAGON",
        nombre: "EMITIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      conReflejo,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("APPROVE");
  });

  it("NO perdona un dígito en el número de documento: es otro documento", () => {
    const otroNumero = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380011",
        fecha_nacimiento: "1998-04-06",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "ARG",
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380011",
        fecha_nacimiento: "1998-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      otroNumero,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LA_CUENTA");
  });

  it("manda a repetir SOLO la foto que no se pudo leer", () => {
    const dorsoNegro = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.ocr": {},
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      dorsoNegro,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("FOTO_ILEGIBLE");
    // El frente sirve y se puede reutilizar: no aparece en retakeSlots.
    expect(report.retakeSlots).toEqual(["dni_back"]);
  });

  it("rechaza un documento que no es argentino", () => {
    const extranjero = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
        fecha_vencimiento: "2039-04-06",
      },
      "dorso.mrz": {
        tipo_documento: "ID",
        pais_emisor: "BRA",
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        fecha_nacimiento: "1998-04-06",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      extranjero,
      CUENTA,
      DNI_DECLARADO,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DOCUMENTO_NO_ES_ARGENTINO");
    expect(motivo(report, "DOCUMENTO_NO_ES_ARGENTINO").action).toBe(
      "USE_VALID_DOCUMENT",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("IdentityMatchService · lo declarado contra lo que dice la foto", () => {
  it("falla si el vencimiento cargado no es el del documento", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.DNI,
      DNI_PERFECTO,
      CUENTA,
      { expiresAt: dia("2030-01-01") },
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LO_DECLARADO");
    // Corregir el dato, no repetir la foto: la foto está perfecta.
    expect(motivo(report, "DATO_NO_COINCIDE_CON_LO_DECLARADO").action).toBe(
      "FIX_DECLARED_DATA",
    );
    expect(report.retakeSlots).toEqual([]);
  });

  it("falla si la clase de licencia cargada no es la del documento", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      LICENCIA_PERFECTA,
      CUENTA,
      { ...LICENCIA_DECLARADA, licenseClass: "C.2" },
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("DATO_NO_COINCIDE_CON_LO_DECLARADO");
  });

  it("acepta la misma clase escrita distinto: B1, B.1 y b 1", () => {
    for (const clase of ["B1", "B.1", "b 1"]) {
      const report = matcher.evaluate(
        VerifiedDocumentType.LICENSE,
        LICENCIA_PERFECTA,
        CUENTA,
        { ...LICENCIA_DECLARADA, licenseClass: clase },
      );
      expect(report.verdict).toBe("APPROVE");
    }
  });

  it("no falla por un dato declarado que la foto no llegó a mostrar", () => {
    // La fecha de otorgamiento no se leyó. Eso no prueba que lo declarado esté
    // mal, y mandar a corregir un dato correcto sería peor que no controlarlo.
    const sinOtorgamiento = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_licencia: "49380010",
        fecha_vencimiento: "2032-08-15",
        clase: "B.1",
      },
      "dorso.pdf417": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_licencia: "49380010",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      sinOtorgamiento,
      CUENTA,
      LICENCIA_DECLARADA,
    );

    expect(report.verdict).toBe("APPROVE");
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("IdentityMatchService · licencia", () => {
  it("aprueba una licencia que cierra por todos lados", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      LICENCIA_PERFECTA,
      CUENTA,
      LICENCIA_DECLARADA,
    );

    expect(report.verdict).toBe("APPROVE");
  });

  it("falla si el número de licencia no es el del DNI: son dos personas", () => {
    const mezclada = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_documento: "49380010",
        numero_licencia: "11222333",
        fecha_vencimiento: "2032-08-15",
        clase: "B.1",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      mezclada,
      CUENTA,
      LICENCIA_DECLARADA,
    );

    expect(report.verdict).toBe("FAIL");
    expect(codigos(report)).toContain("LICENCIA_NO_ES_DEL_TITULAR");
  });

  it("APRUEBA una licencia vencida: es auténtica y es suya", () => {
    // Lo que la vencida no puede es habilitar a manejar, y eso lo resuelve la
    // capa de habilitación. Negarle la verificación la dejaría sin cuenta Y sin
    // poder manejar, cuando el problema es uno solo.
    const vencida = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_licencia: "49380010",
        fecha_vencimiento: "2020-01-01",
        fecha_otorgamiento: "2015-01-01",
        clase: "B.1",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      vencida,
      CUENTA,
      {
        expiresAt: dia("2020-01-01"),
        issuedAt: dia("2015-01-01"),
        licenseClass: "B.1",
        isBeginner: false,
        beginnerUntil: null,
      },
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).toContain("LICENCIA_VENCIDA");
    expect(motivo(report, "LICENCIA_VENCIDA").action).toBe(
      "USE_VALID_DOCUMENT",
    );
  });

  it("aprueba una licencia de moto, y deja anotado que no habilita autos", () => {
    const deMoto = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_licencia: "49380010",
        fecha_vencimiento: "2032-08-15",
        fecha_otorgamiento: "2027-08-15",
        clase: "A2.2",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      deMoto,
      CUENTA,
      { ...LICENCIA_DECLARADA, licenseClass: "A2.2" },
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).toContain("LICENCIA_CLASE_NO_HABILITA");
  });

  it("aprueba una licencia de principiante y anota hasta cuándo lo es", () => {
    const principiante = lectura({
      "frente.ocr": {
        apellido: "TEJADA ARAGON",
        nombre: "EMILIANO",
        numero_licencia: "49380010",
        fecha_vencimiento: "2032-08-15",
        fecha_otorgamiento: "2027-08-15",
        clase: "B.1",
        es_principiante: "true",
      },
    });

    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      principiante,
      CUENTA,
      {
        ...LICENCIA_DECLARADA,
        isBeginner: true,
        beginnerUntil: dia("2099-01-01"),
      },
    );

    expect(report.verdict).toBe("APPROVE");
    expect(codigos(report)).toContain("LICENCIA_PRINCIPIANTE");
  });

  it("falla si declara ser principiante y el documento no lo dice", () => {
    const report = matcher.evaluate(
      VerifiedDocumentType.LICENSE,
      LICENCIA_PERFECTA,
      CUENTA,
      {
        ...LICENCIA_DECLARADA,
        isBeginner: true,
        beginnerUntil: dia("2099-01-01"),
      },
    );

    // LICENCIA_PERFECTA no trae la marca de principiante en ninguna cara, así
    // que no hay contra qué contrastar: no se falla por lo que no se leyó.
    expect(report.verdict).toBe("APPROVE");
  });
});
