import { DocumentExtraction } from "../extraction/extraction.types";
import {
  FIELD_PRECEDENCE,
  buildFieldMatrix,
  compareField,
} from "./field-comparison";
import { IdentityProfileSnapshot } from "./identity-match.service";

const PERFIL: IdentityProfileSnapshot = {
  firstName: "Juan Carlos",
  lastName: "Pérez",
  dateOfBirth: new Date("1990-02-01T00:00:00.000Z"),
  dni: "12345678",
  cuil: "20-12345678-6",
  address: "Av. Siempre Viva 742",
};

function extraccion(
  overrides: Partial<DocumentExtraction> = {},
): DocumentExtraction {
  return {
    dniBarcode: {
      procedureNumber: "00123456789",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      dni: "12345678",
      copy: "A",
      birthDate: "1990-02-01",
      issueDate: "2015-03-05",
    },
    mrz: {
      documentNumber: "12345678",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      birthDate: "1990-02-01",
      expiryDate: "2030-02-15",
      nationality: "ARG",
      checksumValid: true,
    },
    licenseCode: { dni: "12345678", expiryDate: "2031-05-20", parsed: true },
    ocr: {
      dni_front: {
        classifiedAs: "dni_front",
        fields: {
          apellido: "PEREZ",
          nombre: "JUAN CARLOS",
          nroDocumento: "12.345.678",
          fechaNacimiento: "01/02/1990",
          fechaVencimiento: "15/02/2030",
          sexo: "M",
        },
      },
      dni_back: {
        classifiedAs: "dni_back",
        fields: { domicilio: "AV SIEMPRE VIVA 742 CABA", cuil: "20123456786" },
      },
      license_front: {
        classifiedAs: "license_front",
        fields: {
          apellido: "PEREZ",
          nombre: "JUAN CARLOS",
          nroDocumento: "12345678",
          fechaVencimiento: "20/05/2031",
        },
      },
      license_back: { classifiedAs: "license_back", fields: {} },
    },
    ...overrides,
  };
}

const matriz = (
  perfil: Partial<IdentityProfileSnapshot> = {},
  documentos: Partial<DocumentExtraction> = {},
) =>
  buildFieldMatrix(
    { ...PERFIL, ...(documentos ? perfil : perfil) },
    extraccion(documentos),
  );

/**
 * Esta capa no decide nada: describe. Su trabajo es que, para cada dato,
 * quede a la vista qué dice cada fuente y si se contradicen. Lo que se hace
 * con una contradicción es otra cosa y vive en IdentityMatchService.
 */
describe("buildFieldMatrix", () => {
  it("junta todas las fuentes que tienen el dato", () => {
    const apellido = matriz().lastName;

    expect(apellido.observations.map((o) => o.source).sort()).toEqual([
      "form",
      "mrz",
      "ocr_dni_front",
      "ocr_license_front",
      "pdf417_dni",
    ]);
    expect(apellido.status).toBe("agree");
  });

  it("marca cuáles fuentes no las escribió un modelo", () => {
    const { observations } = matriz().documentNumber;
    const confiables = observations
      .filter((o) => o.trusted)
      .map((o) => o.source);

    expect(confiables).toContain("pdf417_dni");
    expect(confiables).toContain("form");
    expect(confiables).not.toContain("ocr_dni_front");
  });

  it("guarda el valor tal cual está escrito y el normalizado", () => {
    const observacion = matriz().documentNumber.observations.find(
      (o) => o.source === "ocr_dni_front",
    );

    expect(observacion?.raw).toBe("12.345.678");
    expect(observacion?.normalized).toBe("12345678");
  });

  it("detecta la contradicción y dice exactamente quién dice qué", () => {
    const conflicto = matriz({ lastName: "Gómez" }).lastName;

    expect(conflicto.status).toBe("conflict");
    expect(conflicto.conflicts[0].detail).toContain("formulario");
    expect(conflicto.conflicts[0].detail).toContain("Gómez");
    expect(conflicto.conflicts[0].detail).toContain("PEREZ");
  });

  it("un segundo nombre de más es compatible, no una contradicción", () => {
    const nombres = matriz({ firstName: "Juan" }).firstName;

    expect(nombres.status).toBe("agree");
    expect(nombres.conflicts[0].verdict).toBe("compatible");
  });

  it("el domicilio se compara por parecido y deja el número a la vista", () => {
    const domicilio = matriz().address;

    expect(domicilio.status).toBe("agree");
    expect(domicilio.similarity).toBeGreaterThan(0.5);
  });

  it("un domicilio de otra ciudad sí es una contradicción", () => {
    expect(matriz({ address: "Otra Calle 999, Rosario" }).address.status).toBe(
      "conflict",
    );
  });

  it("un dato de una sola fuente no es coincidencia ni contradicción", () => {
    const soloUno = buildFieldMatrix(PERFIL, {
      ...extraccion(),
      dniBarcode: null,
      mrz: null,
      licenseCode: null,
      ocr: {},
    });

    expect(soloUno.documentNumber.status).toBe("single-source");
    expect(soloUno.sex.status).toBe("missing");
  });

  it("ignora el MRZ cuyos dígitos verificadores no cierran", () => {
    // Un MRZ mal transcripto inventa contradicciones que no existen.
    const conMrzRoto = buildFieldMatrix(PERFIL, {
      ...extraccion(),
      mrz: {
        ...extraccion().mrz!,
        lastName: "GOMEZ",
        checksumValid: false,
      },
    });

    expect(conMrzRoto.lastName.observations.map((o) => o.source)).not.toContain(
      "mrz",
    );
    expect(conMrzRoto.lastName.status).toBe("agree");
  });

  describe("qué fuente gana", () => {
    it("el código del DNI le gana al texto impreso y al formulario", () => {
      expect(matriz().documentNumber.resolved).toEqual({
        value: "12345678",
        source: "pdf417_dni",
      });
    });

    it("el vencimiento del DNI sale del MRZ antes que del texto impreso", () => {
      expect(FIELD_PRECEDENCE.dniExpiry[0]).toBe("mrz");
      expect(matriz().dniExpiry.resolved?.source).toBe("mrz");
    });

    it("el de la licencia sale del texto impreso antes que del código", () => {
      // Es al revés que el del DNI, a propósito: el código de la licencia no
      // está estandarizado y muchas veces trae un vencimiento viejo o ninguno.
      expect(FIELD_PRECEDENCE.licenseExpiry[0]).toBe("ocr_license_front");
      expect(matriz().licenseExpiry.resolved).toEqual({
        value: "2031-05-20",
        source: "ocr_license_front",
      });
    });

    it("el CUIL sale del formulario: no está en ningún código", () => {
      expect(matriz().cuil.resolved?.source).toBe("form");
    });

    it("cae a la fuente siguiente cuando la preferida no tiene el dato", () => {
      const sinCodigo = buildFieldMatrix(PERFIL, {
        ...extraccion(),
        dniBarcode: null,
      });
      expect(sinCodigo.lastName.resolved?.source).toBe("mrz");
    });
  });
});

describe("compareField", () => {
  it("un valor que no se pudo normalizar no participa de la comparación", () => {
    const resultado = compareField("birthDate", [
      {
        source: "form",
        raw: "1990-02-01",
        normalized: "1990-02-01",
        trusted: true,
      },
      {
        source: "ocr_dni_front",
        raw: "31/02/1990",
        normalized: null,
        trusted: false,
      },
    ]);

    // La fecha ilegible se conserva para poder mirarla, pero no inventa un
    // conflicto: no se sabe qué decía.
    expect(resultado.status).toBe("single-source");
    expect(resultado.conflicts).toEqual([]);
    expect(resultado.observations).toHaveLength(2);
  });

  it("sin ninguna fuente, el campo queda como faltante", () => {
    expect(compareField("cuil", []).status).toBe("missing");
    expect(compareField("cuil", []).resolved).toBeNull();
  });
});
