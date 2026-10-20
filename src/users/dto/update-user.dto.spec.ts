/**
 * El encuadre de la portada, visto desde la puerta de entrada.
 *
 * Estos dos números terminan adentro de una propiedad de CSS en el front
 * (`background-position: 12% 88%`). Guardarlos como enteros acotados en vez de
 * como un texto con la posición ya armada es justamente lo que evita tener que
 * desconfiar de ellos al dibujar: si acá no entra nada que no sea un número
 * entre 0 y 100, abajo no hay nada que revisar.
 *
 * Esta prueba es la que sostiene esa afirmación. Sin ella, aflojar un decorador
 * —o perderlo en un merge— no rompe ningún test y el front queda imprimiendo lo
 * que venga de la base.
 */
// Los decoradores guardan el tipo de cada campo acá; en la aplicación lo carga
// main.ts, pero una prueba suelta arranca sin eso y `@Type` explota.
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UpdateUserDto } from "./update-user.dto";

/** Los campos que no pasaron la validación de este cuerpo. */
const rechazados = (body: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(UpdateUserDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("UpdateUserDto — el encuadre de la portada", () => {
  it("acepta los dos extremos y el medio", () => {
    for (const valor of [0, 50, 100]) {
      expect(
        rechazados({ profileCoverX: valor, profileCoverY: valor }),
      ).toEqual([]);
    }
  });

  it("acepta el número escrito como texto, que es como viaja en JSON", () => {
    const dto = plainToInstance(UpdateUserDto, { profileCoverX: "70" });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.profileCoverX).toBe(70);
  });

  it("NO ACEPTA NADA QUE NO SEA UN NÚMERO ENTRE 0 Y 100", () => {
    const basura = [
      "50%; background: red",
      "center",
      "url(http://x)",
      -1,
      101,
      10.5,
      Number.NaN,
      {},
    ];
    for (const malo of basura) {
      expect(rechazados({ profileCoverX: malo })).toEqual(["profileCoverX"]);
      expect(rechazados({ profileCoverY: malo })).toEqual(["profileCoverY"]);
    }
  });

  it("Y LO QUE PASA SIEMPRE ES UN ENTERO, NUNCA UN TEXTO", () => {
    /*
      Es la promesa de la que depende el front: lo que llega acá se guarda, y lo
      guardado se imprime adentro de una propiedad de estilo. Un `true` o un
      arreglo vacío no los rechaza el validador —`@Type(() => Number)` los
      convierte en 1 y en 0 antes de mirarlos—, y está bien que así sea: lo que
      queda guardado es un número chico y no la cosa rara que mandaron.

      Lo que NO puede pasar nunca es que sobreviva un texto. Por eso la prueba
      no es "esto se rechaza" sino la propiedad entera: de todo lo que se mande,
      o no entra, o entra convertido en un entero de 0 a 100.
    */
    const cualquierCosa = [
      0,
      50,
      100,
      "70",
      true,
      false,
      [],
      -1,
      101,
      10.5,
      "center",
      "50%",
      {},
      Number.NaN,
      "",
      " ",
    ];
    for (const valor of cualquierCosa) {
      const dto = plainToInstance(UpdateUserDto, { profileCoverX: valor });
      if (validateSync(dto).length > 0) continue; // no entró, listo
      expect(typeof dto.profileCoverX).toBe("number");
      expect(Number.isInteger(dto.profileCoverX)).toBe(true);
      expect(dto.profileCoverX).toBeGreaterThanOrEqual(0);
      expect(dto.profileCoverX).toBeLessThanOrEqual(100);
    }
  });

  it("y se puede no mandarlo: el encuadre es opcional", () => {
    expect(rechazados({})).toEqual([]);
    expect(rechazados({ profileCoverX: undefined })).toEqual([]);
  });
});
