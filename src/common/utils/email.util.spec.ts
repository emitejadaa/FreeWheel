import { normalizeEmail } from "./email.util";

describe("normalizeEmail", () => {
  it("deja el email en minúsculas: es la única forma en que se guarda", () => {
    expect(normalizeEmail("Ana@Gmail.com")).toBe("ana@gmail.com");
    expect(normalizeEmail("ANA@GMAIL.COM")).toBe("ana@gmail.com");
  });

  it("saca los espacios que se cuelan al copiar y pegar", () => {
    expect(normalizeEmail("  ana@gmail.com  ")).toBe("ana@gmail.com");
    expect(normalizeEmail("\tAna@Gmail.com\n")).toBe("ana@gmail.com");
  });

  it("hace que dos formas de escribir la misma dirección den lo mismo", () => {
    expect(normalizeEmail("Ana@Gmail.com")).toBe(
      normalizeEmail("ana@GMAIL.com"),
    );
  });

  it("NO toca los alias con + ni los puntos: son direcciones distintas", () => {
    expect(normalizeEmail("ana+autos@gmail.com")).toBe("ana+autos@gmail.com");
    expect(normalizeEmail("a.n.a@gmail.com")).toBe("a.n.a@gmail.com");
  });

  it("devuelve null cuando no hay una dirección que normalizar", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});
