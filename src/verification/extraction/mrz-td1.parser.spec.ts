import { mrzCheckDigit, parseMrzTd1 } from "./mrz-td1.parser";

/**
 * MRZ TD1 sintético con dígitos verificadores calculados a mano (no con el
 * código bajo test, para que el spec no sea circular):
 *  - documento "12345678<" → 8
 *  - nacimiento "900201"   → 8
 *  - vencimiento "300215"  → 3
 *  - compuesto             → 8
 */
const LINE1 = "I<ARG12345678<8<<<<<<<<<<<<<<<";
const LINE2 = "9002018M3002153ARG<<<<<<<<<<<8";
const LINE3 = "PEREZ<<JUAN<CARLOS<<<<<<<<<<<<";
const VALID = [LINE1, LINE2, LINE3];

describe("mrzCheckDigit", () => {
  it("aplica los pesos 7-3-1 con las equivalencias ICAO", () => {
    expect(mrzCheckDigit("12345678<")).toBe(8);
    expect(mrzCheckDigit("900201")).toBe(8);
    expect(mrzCheckDigit("300215")).toBe(3);
    // 'A' vale 10: 10*7 = 70 → 0.
    expect(mrzCheckDigit("A")).toBe(0);
    expect(mrzCheckDigit("<")).toBe(0);
  });

  it("devuelve null ante caracteres fuera del alfabeto MRZ", () => {
    expect(mrzCheckDigit("12a45")).toBeNull();
    expect(mrzCheckDigit("Ñ")).toBeNull();
  });
});

describe("parseMrzTd1", () => {
  it("lee todos los campos y valida los check digits", () => {
    expect(parseMrzTd1(VALID)).toEqual({
      documentNumber: "12345678",
      lastName: "PEREZ",
      firstName: "JUAN CARLOS",
      sex: "M",
      birthDate: "1990-02-01",
      expiryDate: "2030-02-15",
      nationality: "ARG",
      checksumValid: true,
    });
  });

  it("tolera espacios y minúsculas de la transcripción del OCR", () => {
    const messy = [` ${LINE1} `, LINE2.toLowerCase(), `${LINE3}\n`];
    expect(parseMrzTd1(messy)?.checksumValid).toBe(true);
  });

  it("marca checksumValid=false si un solo carácter fue mal transcripto", () => {
    // 12345678 → 12345679: el dígito verificador deja de cerrar.
    const corrupted = [LINE1.replace("12345678", "12345679"), LINE2, LINE3];
    const parsed = parseMrzTd1(corrupted);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksumValid).toBe(false);
    // Igual devuelve los datos: el caller decide tratarlos como no disponibles.
    expect(parsed?.documentNumber).toBe("12345679");
  });

  it("detecta una fecha de nacimiento alterada por el check compuesto", () => {
    const corrupted = [LINE1, LINE2.replace("9002018", "9002028"), LINE3];
    expect(parseMrzTd1(corrupted)?.checksumValid).toBe(false);
  });

  it("devuelve null si no hay exactamente 3 líneas de 30 caracteres", () => {
    expect(parseMrzTd1([LINE1, LINE2])).toBeNull();
    expect(parseMrzTd1([LINE1, LINE2, LINE3.slice(0, 25)])).toBeNull();
    expect(parseMrzTd1([])).toBeNull();
  });

  it("devuelve null si las fechas o el documento no son legibles", () => {
    const badDate = [LINE1, `999999${LINE2.slice(6)}`, LINE3];
    expect(parseMrzTd1(badDate)).toBeNull();
  });

  it("separa apellido de nombres aunque falte el segundo bloque", () => {
    const onlySurname = [LINE1, LINE2, "PEREZ<<<<<<<<<<<<<<<<<<<<<<<<<"];
    const parsed = parseMrzTd1(onlySurname);
    expect(parsed?.lastName).toBe("PEREZ");
    expect(parsed?.firstName).toBe("");
  });
});
