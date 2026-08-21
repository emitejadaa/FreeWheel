import {
  normalizeClassification,
  parseOcrResponse,
  toOcrExtraction,
} from "./ocr-response.parser";

/** El JSON que se le pidió al modelo, tal como debería contestar. */
const CANONICA = JSON.stringify({
  documento: "dni_frente",
  campos: {
    apellido: { valor: "PEREZ", etiqueta: "Apellido / Surname", legible: true },
    nombres: { valor: "JUAN CARLOS", etiqueta: "Nombre / Name", legible: true },
    sexo: { valor: "M", etiqueta: "Sexo / Sex", legible: true },
    nro_documento: {
      valor: "12.345.678",
      etiqueta: "Documento / Document",
      caja: [120, 340, 260, 40],
      legible: true,
    },
    fecha_nacimiento: { valor: "01/02/1990", etiqueta: "Fecha de nacimiento" },
    fecha_vencimiento: { valor: "15/02/2030", etiqueta: "Vencimiento" },
  },
  texto_completo: "REPUBLICA ARGENTINA\nPEREZ\nJUAN CARLOS\n12.345.678",
  observaciones: null,
});

function leer(
  raw: string,
  slot: Parameters<typeof parseOcrResponse>[0] = "dni_front",
) {
  const result = parseOcrResponse(slot, raw, {
    model: "modelo-x",
    durationMs: 42,
  });
  if (!result.ok)
    throw new Error(`se esperaba una lectura: ${result.error.code}`);
  return result.data;
}

function codigos(
  raw: string,
  slot: Parameters<typeof parseOcrResponse>[0] = "dni_front",
) {
  return leer(raw, slot).warnings.map((w) => w.code);
}

/**
 * Este parser es la frontera entre "lo que contestó un modelo" y "datos".
 * Todo lo que entra es sospechoso: puede venir con el formato pedido, con el
 * anterior, envuelto en markdown, cortado por la mitad o con campos
 * inventados. La regla es no perder nada en silencio: lo que no se puede usar
 * se descarta, pero queda anotado con el motivo.
 */
describe("parseOcrResponse", () => {
  describe("la respuesta que se pidió", () => {
    it("lee los campos con su valor normalizado y el texto original", () => {
      const read = leer(CANONICA);

      expect(read.classifiedAs).toBe("dni_front");
      expect(read.fields.lastName).toEqual({
        raw: "PEREZ",
        value: "PEREZ",
        label: "Apellido / Surname",
        legible: true,
      });
      // El valor normalizado es comparable; el crudo queda para mirarlo.
      expect(read.fields.documentNumber?.raw).toBe("12.345.678");
      expect(read.fields.documentNumber?.value).toBe("12345678");
      expect(read.fields.birthDate?.value).toBe("1990-02-01");
      expect(read.fields.sex?.value).toBe("M");
      expect(read.warnings).toEqual([]);
      expect(read.model).toBe("modelo-x");
      expect(read.durationMs).toBe(42);
    });

    it("guarda la posición del dato cuando el modelo la informa", () => {
      expect(leer(CANONICA).fields.documentNumber?.box).toEqual({
        x: 120,
        y: 340,
        w: 260,
        h: 40,
      });
    });

    it("conserva el texto completo de la foto", () => {
      expect(leer(CANONICA).rawText).toContain("REPUBLICA ARGENTINA");
    });
  });

  describe("formas en las que el modelo se desvía", () => {
    it("acepta los campos como lista en vez de objeto", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: [
          { campo: "apellido", valor: "PEREZ" },
          { campo: "nro_documento", valor: "12345678" },
        ],
      });

      const read = leer(raw);
      expect(read.fields.lastName?.value).toBe("PEREZ");
      expect(read.fields.documentNumber?.value).toBe("12345678");
    });

    it("acepta un campo como string pelado, sin evidencia", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { apellido: "PEREZ" },
      });
      expect(leer(raw).fields.lastName?.value).toBe("PEREZ");
    });

    it("entiende el formato anterior y lo deja anotado", () => {
      // Es el formato que contestaba antes de este cambio. Se lee igual: si el
      // modelo se cae a él, la verificación no se cae con él.
      const raw = JSON.stringify({
        classifiedAs: "dni_front",
        fields: { apellido: "PEREZ", nroDocumento: "12345678" },
      });

      const read = leer(raw);
      expect(read.classifiedAs).toBe("dni_front");
      expect(read.fields.lastName?.value).toBe("PEREZ");
      expect(read.warnings.map((w) => w.code)).toContain("OCR_LEGACY_SHAPE");
    });

    it("entiende los campos sueltos en la raíz", () => {
      const raw = JSON.stringify({
        apellido: "PEREZ",
        nro_documento: "12345678",
      });
      expect(leer(raw).fields.lastName?.value).toBe("PEREZ");
    });

    it("saca el JSON de entre los ``` de markdown", () => {
      expect(
        leer("```json\n" + CANONICA + "\n```").fields.lastName?.value,
      ).toBe("PEREZ");
    });

    it("descarta el razonamiento que algunos modelos escriben antes", () => {
      const raw = `<think>A ver, la foto muestra un documento {con llaves}</think>\n${CANONICA}`;
      expect(leer(raw).fields.lastName?.value).toBe("PEREZ");
    });

    it("acepta números donde se esperaba texto", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { nro_documento: { valor: 12345678 } },
      });
      expect(leer(raw).fields.documentNumber?.value).toBe("12345678");
    });

    it("ignora los campos vacíos, nulos o con la palabra null", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: {
          apellido: { valor: "PEREZ" },
          nombres: { valor: "" },
          sexo: { valor: null },
          nro_documento: { valor: "N/A" },
        },
      });

      const read = leer(raw);
      expect(read.fields.lastName).toBeDefined();
      expect(read.fields.firstName).toBeUndefined();
      expect(read.fields.sex).toBeUndefined();
      expect(read.fields.documentNumber).toBeUndefined();
    });
  });

  describe("respuestas que no se pueden usar", () => {
    it("avisa cuando no hay JSON, mostrando qué contestó", () => {
      const result = parseOcrResponse(
        "dni_front",
        "No puedo ayudarte con eso.",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_RESPONSE_NOT_JSON");
      expect(result.error.message).toContain("No puedo ayudarte");
    });

    it("avisa cuando la respuesta llegó cortada por la mitad", () => {
      const result = parseOcrResponse(
        "dni_front",
        '{"documento": "dni_frente", "campos": {"apellido": {"valor": "PER',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_RESPONSE_NOT_JSON");
    });

    it("avisa cuando el JSON no es un objeto", () => {
      const result = parseOcrResponse("dni_front", "[1, 2, 3]");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("OCR_RESPONSE_NOT_JSON");
    });
  });

  describe("qué documento dice que es", () => {
    it.each([
      ["dni_front", "dni_front"],
      ["dni_frente", "dni_front"],
      ["DNI_FRONT", "dni_front"],
      ["frente del DNI", "dni_front"],
      ["anverso del DNI", "dni_front"],
      ["dni_dorso", "dni_back"],
      ["dorso de la licencia", "license_back"],
    ])('entiende "%s" como %s', (dice, esperado) => {
      const raw = JSON.stringify({ documento: dice, campos: {} });
      expect(parseOcrResponse("dni_front", raw)).toMatchObject({
        ok: true,
        data: { classifiedAs: esperado },
      });
    });

    it("nombrar solo el documento no contradice el lado que se esperaba", () => {
      // Un modelo que contesta "DNI" no está diciendo que la foto esté mal.
      // Tomarlo por "no sé qué es esto" mandaba a revisión manual
      // verificaciones perfectas.
      const raw = JSON.stringify({ documento: "DNI", campos: {} });
      const read = leer(raw, "dni_back");

      expect(read.classifiedAs).toBe("dni_back");
      expect(read.classifiedAsRaw).toBe("DNI");
      expect(read.warnings.map((w) => w.code)).toContain(
        "OCR_CLASSIFICATION_ALIASED",
      );
    });

    it("nombrar el otro documento sí es una contradicción", () => {
      const raw = JSON.stringify({ documento: "licencia", campos: {} });
      expect(leer(raw, "dni_front").classifiedAs).toBe("license_front");
    });

    it("lo que no reconoce queda como desconocido, con su motivo", () => {
      const raw = JSON.stringify({ documento: "pasaporte", campos: {} });
      const read = leer(raw);

      expect(read.classifiedAs).toBe("unknown");
      expect(read.classifiedAsRaw).toBe("pasaporte");
      expect(read.warnings.map((w) => w.code)).toContain(
        "OCR_DOCUMENT_UNRECOGNIZED",
      );
    });
  });

  describe("lo que se descarta queda anotado", () => {
    it("descarta un campo que no se pidió", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { nacionalidad: { valor: "ARGENTINA" } },
      });

      const read = leer(raw);
      expect(Object.keys(read.fields)).toEqual([]);
      const aviso = read.warnings.find((w) => w.code === "OCR_FIELD_UNKNOWN");
      expect(aviso?.message).toContain("nacionalidad");
    });

    it("descarta un campo que no corresponde a ese lado del documento", () => {
      const raw = JSON.stringify({
        documento: "licencia_dorso",
        campos: { cuil: { valor: "20123456786" } },
      });

      const read = leer(raw, "license_back");
      expect(read.fields.cuil).toBeUndefined();
      expect(
        read.warnings.find((w) => w.code === "OCR_FIELD_UNKNOWN")?.message,
      ).toContain("license_back");
    });

    it("conserva el texto crudo de un valor que no se pudo interpretar", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { fecha_nacimiento: { valor: "31/02/1990" } },
      });

      const read = leer(raw);
      expect(read.fields.birthDate?.raw).toBe("31/02/1990");
      expect(read.fields.birthDate?.value).toBeNull();
      const aviso = read.warnings.find(
        (w) => w.code === "OCR_FIELD_UNPARSEABLE",
      );
      expect(aviso?.message).toContain("31/02/1990");
      expect(aviso?.message).toContain("una fecha");
    });

    it("descarta una posición imposible pero se queda con el dato", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { apellido: { valor: "PEREZ", caja: [5000, 10, 20, 30] } },
      });

      const read = leer(raw);
      expect(read.fields.lastName?.value).toBe("PEREZ");
      expect(read.fields.lastName?.box).toBeUndefined();
      expect(read.warnings.map((w) => w.code)).toContain("OCR_BOX_INVALID");
    });

    it("recorta un texto completo desmedido", () => {
      const raw = JSON.stringify({
        documento: "dni_frente",
        campos: { apellido: { valor: "PEREZ" } },
        texto_completo: "A".repeat(3000),
      });

      const read = leer(raw);
      expect(read.rawText).toHaveLength(600);
      expect(read.warnings.map((w) => w.code)).toContain("OCR_TEXT_TRUNCATED");
    });

    it("avisa cuando no se pudo leer ni un campo", () => {
      const raw = JSON.stringify({ documento: "dni_frente", campos: {} });
      expect(codigos(raw)).toContain("OCR_NO_FIELDS");
    });
  });

  describe("el MRZ del dorso", () => {
    const LINEAS = [
      "I<ARG12345678<8<<<<<<<<<<<<<<<",
      "9002018M3002153ARG<<<<<<<<<<<8",
      "PEREZ<<JUAN<CARLOS<<<<<<<<<<<<",
    ];

    it("lo lee de la clave mrz", () => {
      const raw = JSON.stringify({ documento: "dni_dorso", mrz: LINEAS });
      expect(leer(raw, "dni_back").mrzLines).toEqual(LINEAS);
    });

    it("lo lee del nombre que usaba el formato anterior", () => {
      const raw = JSON.stringify({
        classifiedAs: "dni_back",
        fields: { mrzLines: LINEAS },
      });
      expect(leer(raw, "dni_back").mrzLines).toEqual(LINEAS);
    });

    it("lo lee cuando viene línea por línea", () => {
      const raw = JSON.stringify({
        documento: "dni_dorso",
        campos: {
          mrz_linea_1: { valor: LINEAS[0] },
          mrz_linea_2: { valor: LINEAS[1] },
          mrz_linea_3: { valor: LINEAS[2] },
        },
      });
      expect(leer(raw, "dni_back").mrzLines).toEqual(LINEAS);
    });

    it("no cuenta las líneas del MRZ como campos desconocidos", () => {
      const raw = JSON.stringify({
        documento: "dni_dorso",
        campos: { mrz_linea_1: { valor: LINEAS[0] } },
      });
      expect(codigos(raw, "dni_back")).not.toContain("OCR_FIELD_UNKNOWN");
    });
  });
});

describe("toOcrExtraction", () => {
  it("proyecta al formato plano que consume el cruce", () => {
    const extraction = toOcrExtraction(leer(CANONICA));

    expect(extraction.classifiedAs).toBe("dni_front");
    // El cruce recibe el texto CRUDO: normaliza por su cuenta y así puede
    // comparar contra lo que la persona escribió, que también es crudo.
    expect(extraction.fields).toEqual({
      apellido: "PEREZ",
      nombre: "JUAN CARLOS",
      sexo: "M",
      nroDocumento: "12.345.678",
      fechaNacimiento: "01/02/1990",
      fechaVencimiento: "15/02/2030",
    });
  });

  it("adjunta la evidencia sin tocar el formato plano", () => {
    const extraction = toOcrExtraction(leer(CANONICA));

    expect(extraction.evidence?.documentNumber?.box).toBeDefined();
    expect(extraction.rawText).toContain("REPUBLICA");
    expect(extraction.warnings).toEqual([]);
  });
});

describe("normalizeClassification", () => {
  it("no inventa un documento cuando no hay nada que interpretar", () => {
    expect(normalizeClassification(null, "dni_front").slot).toBe("unknown");
    expect(normalizeClassification("", "dni_front").slot).toBe("unknown");
    expect(normalizeClassification(42, "dni_front").slot).toBe("unknown");
  });
});
