import {
  MAX_REVIEW_TAGS,
  REVIEW_TAGS,
  REVIEW_TAG_CODES,
  tagAppliesTo,
} from "./review-tags";

describe("review-tags", () => {
  it("no repite códigos", () => {
    expect(new Set(REVIEW_TAG_CODES).size).toBe(REVIEW_TAG_CODES.length);
  });

  /*
    La regla que sostiene todo lo demás: si existe "contesta rápido" tiene que
    existir "tardó en contestar". Una lista con más elogios que quejas empuja la
    reseña hacia lo bueno, porque la persona encuentra dónde tocar para decir
    algo lindo y no encuentra dónde decir lo que de verdad le pasó.
  */
  it("cada característica buena tiene su contraria, para el mismo público", () => {
    const PARES: Array<[string, string]> = [
      ["RESPONDE_RAPIDO", "RESPONDE_TARDE"],
      ["TRATO_AMABLE", "TRATO_AGRESIVO"],
      ["PUNTUAL", "IMPUNTUAL"],
      ["AUTO_COMO_LA_FOTO", "AUTO_DISTINTO"],
      ["AUTO_LIMPIO", "AUTO_SUCIO"],
      ["SIN_COBROS_EXTRA", "COBROS_INESPERADOS"],
      ["CUIDO_EL_AUTO", "MALTRATO_EL_AUTO"],
      ["DEVOLVIO_LIMPIO", "DEVOLVIO_SUCIO"],
    ];
    // Todas las características están en algún par: ninguna quedó suelta.
    expect(PARES.flat().sort()).toEqual([...REVIEW_TAG_CODES].sort());

    for (const [bueno, malo] of PARES) {
      const a = REVIEW_TAGS.find((t) => t.code === bueno);
      const b = REVIEW_TAGS.find((t) => t.code === malo);
      expect(a?.audience).toBe(b?.audience);
    }
  });

  it("una característica del auto solo se le puede poner al dueño", () => {
    expect(tagAppliesTo("AUTO_SUCIO", "OWNER")).toBe(true);
    expect(tagAppliesTo("AUTO_SUCIO", "RENTER")).toBe(false);
    expect(tagAppliesTo("AUTO_COMO_LA_FOTO", "RENTER")).toBe(false);
  });

  it("una característica de la devolución solo se le puede poner a quien alquiló", () => {
    expect(tagAppliesTo("DEVOLVIO_SUCIO", "RENTER")).toBe(true);
    expect(tagAppliesTo("DEVOLVIO_SUCIO", "OWNER")).toBe(false);
    expect(tagAppliesTo("MALTRATO_EL_AUTO", "OWNER")).toBe(false);
  });

  it("las de trato y respuesta valen para los dos lados", () => {
    for (const code of ["RESPONDE_RAPIDO", "TRATO_AGRESIVO", "PUNTUAL"]) {
      expect(tagAppliesTo(code, "OWNER")).toBe(true);
      expect(tagAppliesTo(code, "RENTER")).toBe(true);
    }
  });

  it("un código inventado no aplica a nadie", () => {
    expect(tagAppliesTo("ES_UN_CRACK", "OWNER")).toBe(false);
    expect(tagAppliesTo("", "RENTER")).toBe(false);
  });

  it("el tope deja elegir varias pero no todas", () => {
    expect(MAX_REVIEW_TAGS).toBeGreaterThan(2);
    expect(MAX_REVIEW_TAGS).toBeLessThan(REVIEW_TAG_CODES.length);
  });
});
