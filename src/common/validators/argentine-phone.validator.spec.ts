import {
  formatArgentinePhone,
  isArgentinePhone,
  normalizeArgentinePhone,
} from "./argentine-phone.validator";

describe("normalizeArgentinePhone", () => {
  it("accepts a full mobile number however it is written", () => {
    for (const input of [
      "5491132895416",
      "+54 9 11 3289 5416",
      "+54-9-11-3289-5416",
      "(54) 9 11 3289-5416",
      "005491132895416",
    ]) {
      expect(normalizeArgentinePhone(input)).toBe("+5491132895416");
    }
  });

  it("adds the mobile 9 when it is missing", () => {
    expect(normalizeArgentinePhone("54 11 3289 5416")).toBe("+5491132895416");
  });

  it("drops the national trunk 0", () => {
    expect(normalizeArgentinePhone("54 011 3289 5416")).toBe("+5491132895416");
  });

  it("accepts area codes of other lengths (same 10 digits total)", () => {
    // Córdoba: 351 + 7 dígitos. La Pampa: 2954 + 6 dígitos.
    expect(normalizeArgentinePhone("+54 9 351 123 4567")).toBe(
      "+5493511234567",
    );
    expect(normalizeArgentinePhone("+54 9 2954 12 3456")).toBe(
      "+5492954123456",
    );
  });

  it("rejects an incomplete number", () => {
    // Éste es el caso que se colaba antes: "123" quedaba guardado.
    expect(normalizeArgentinePhone("123")).toBeNull();
    expect(normalizeArgentinePhone("54 123")).toBeNull();
    expect(normalizeArgentinePhone("54 11 3289")).toBeNull();
    expect(normalizeArgentinePhone("")).toBeNull();
  });

  it("rejects a number with too many digits", () => {
    expect(normalizeArgentinePhone("54 9 11 3289 5416 77")).toBeNull();
  });

  it("rejects other countries: el servicio es solo en Argentina", () => {
    expect(normalizeArgentinePhone("+1 415 555 2671")).toBeNull(); // Estados Unidos
    expect(normalizeArgentinePhone("+55 11 91234 5678")).toBeNull(); // Brasil
    expect(normalizeArgentinePhone("+598 91 234 567")).toBeNull(); // Uruguay
  });

  it("rejects non-string input", () => {
    expect(normalizeArgentinePhone(undefined)).toBeNull();
    expect(normalizeArgentinePhone(null)).toBeNull();
    expect(normalizeArgentinePhone(5491132895416)).toBeNull();
  });
});

describe("isArgentinePhone", () => {
  it("mirrors normalize", () => {
    expect(isArgentinePhone("+54 9 11 3289 5416")).toBe(true);
    expect(isArgentinePhone("123")).toBe(false);
  });
});

describe("formatArgentinePhone", () => {
  it("formats for display", () => {
    expect(formatArgentinePhone("5491132895416")).toBe("+54 9 11 3289 5416");
  });

  it("returns the input unchanged when it cannot be parsed", () => {
    expect(formatArgentinePhone("123")).toBe("123");
    expect(formatArgentinePhone(null)).toBe("");
  });
});
