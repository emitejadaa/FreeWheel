import { nombreProlijo, nombreProlijoOpcional } from "./name.util";

/**
 * EL NOMBRE DE UNA PERSONA NO ES UN CAMPO MÁS
 *
 * Aparece en el perfil, en el chat, en la ficha que mira el otro antes de
 * prestarle su auto y en todos los mails. El caso que trajo esto: una cuenta
 * creada desde el celular quedó como "ignacio britos" y así se veía en todos
 * lados.
 *
 * Lo delicado no es poner la mayúscula: es NO ARRUINAR los nombres que ya están
 * bien escritos. Un apellido es de alguien, y "corregirle" un "McDonald" a
 * "Mcdonald" es peor que el problema que se quería resolver.
 */
describe("nombreProlijo", () => {
  it("pone la mayúscula donde falta", () => {
    expect(nombreProlijo("ignacio")).toBe("Ignacio");
    expect(nombreProlijo("britos")).toBe("Britos");
    expect(nombreProlijo("maria jose")).toBe("Maria Jose");
  });

  it("y deja igual lo que ya estaba bien", () => {
    expect(nombreProlijo("Ignacio")).toBe("Ignacio");
    expect(nombreProlijo("Maria Jose")).toBe("Maria Jose");
  });

  it("NO TOCA UN APELLIDO QUE SU DUEÑO ESCRIBIÓ CON MAYÚSCULA ADENTRO", () => {
    // El caso que hace que esto no sea un `.toUpperCase()` del primer carácter.
    for (const apellido of ["McDonald", "DiCaprio", "O'Brien", "LaValle"]) {
      expect(nombreProlijo(apellido)).toBe(apellido);
    }
  });

  it("deja las partículas en minúscula, como se escriben en castellano", () => {
    expect(nombreProlijo("juan de la cruz")).toBe("Juan de la Cruz");
    expect(nombreProlijo("ana van der berg")).toBe("Ana van der Berg");
  });

  it("salvo cuando la partícula ES el apellido", () => {
    // "Da Silva, Ana": ahí "da" es la primera palabra y sí lleva mayúscula.
    expect(nombreProlijo("da silva")).toBe("Da Silva");
    expect(nombreProlijo("de luca")).toBe("De Luca");
  });

  it("también separa por guiones", () => {
    expect(nombreProlijo("ana-maria")).toBe("Ana-Maria");
    expect(nombreProlijo("jean-luc picard")).toBe("Jean-Luc Picard");
  });

  it("limpia los espacios que nadie quiso escribir", () => {
    expect(nombreProlijo("  ignacio   britos  ")).toBe("Ignacio Britos");
  });

  it("y no se rompe con lo vacío", () => {
    expect(nombreProlijo("")).toBe("");
    expect(nombreProlijo("   ")).toBe("");
  });
});

describe("nombreProlijoOpcional", () => {
  it("devuelve undefined cuando no hay nada que cambiar", () => {
    // Importa: lo que devuelve va a un update de Prisma, y un string vacío
    // BORRARÍA el nombre de la cuenta.
    expect(nombreProlijoOpcional(undefined)).toBeUndefined();
    expect(nombreProlijoOpcional(null)).toBeUndefined();
    expect(nombreProlijoOpcional("   ")).toBeUndefined();
  });

  it("y el nombre prolijo cuando sí lo hay", () => {
    expect(nombreProlijoOpcional("ignacio")).toBe("Ignacio");
  });
});
