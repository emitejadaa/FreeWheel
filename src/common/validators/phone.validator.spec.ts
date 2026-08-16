import { isPhone, normalizePhone } from "./phone.validator";

describe("normalizePhone", () => {
  describe("Argentina sigue con la regla estricta de siempre", () => {
    it("acepta un celular argentino completo, lo escriban como lo escriban", () => {
      for (const entrada of [
        "+54 9 11 3289 5416",
        "5491132895416",
        "+54-9-11-3289-5416",
        "0054 9 11 3289 5416",
      ]) {
        expect(normalizePhone(entrada)).toBe("+5491132895416");
      }
    });

    it("le agrega el 9 de celular si vino sin él", () => {
      expect(normalizePhone("54 11 3289 5416")).toBe("+5491132895416");
    });

    it("rechaza un argentino incompleto", () => {
      expect(normalizePhone("54 11 3289")).toBeNull();
      expect(normalizePhone("54 123")).toBeNull();
    });

    it("rechaza un argentino con dígitos de más", () => {
      expect(normalizePhone("54 9 11 3289 5416 77")).toBeNull();
    });
  });

  describe("ahora también entran los de afuera", () => {
    it("acepta números de otros países", () => {
      expect(normalizePhone("+1 415 555 2671")).toBe("+14155552671"); // Estados Unidos
      expect(normalizePhone("+55 11 91234 5678")).toBe("+5511912345678"); // Brasil
      expect(normalizePhone("+598 91 234 567")).toBe("+59891234567"); // Uruguay
      expect(normalizePhone("+34 612 345 678")).toBe("+34612345678"); // España
      expect(normalizePhone("+39 320 123 4567")).toBe("+393201234567"); // Italia
      expect(normalizePhone("+86 138 0013 8000")).toBe("+8613800138000"); // China
    });

    it("acepta el prefijo escrito como 00", () => {
      expect(normalizePhone("0034 612 345 678")).toBe("+34612345678");
    });

    it("rechaza los que son demasiado cortos para ser un teléfono", () => {
      expect(normalizePhone("123")).toBeNull();
      expect(normalizePhone("+34 612")).toBeNull();
    });

    it("rechaza los que pasan el largo máximo de E.164", () => {
      expect(normalizePhone("+34 6123456789012345")).toBeNull();
    });
  });

  it("rechaza vacío y lo que no sea texto", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(5491132895416)).toBeNull();
  });
});

describe("isPhone", () => {
  it("dice que sí para uno argentino y para uno de afuera", () => {
    expect(isPhone("+54 9 11 3289 5416")).toBe(true);
    expect(isPhone("+34 612 345 678")).toBe(true);
  });

  it("dice que no para uno incompleto", () => {
    expect(isPhone("123")).toBe(false);
  });
});
