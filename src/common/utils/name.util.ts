/**
 * CÓMO SE ESCRIBE EL NOMBRE DE UNA PERSONA
 *
 * El perfil decía "ignacio britos". No era un error de la pantalla: la cuenta
 * se había creado escribiendo el nombre en minúscula —como escribe cualquiera
 * en un formulario de celular— y lo que se guardó fue eso. Después ese texto
 * aparece en el perfil, en el chat, en la ficha que ve la otra persona antes de
 * prestarle su auto y en los mails. Un nombre en minúscula ahí se lee como un
 * dato cargado de cualquier manera, que es exactamente lo contrario de lo que
 * tiene que transmitir el lugar donde alguien decide si confía.
 *
 * Se arregla AL GUARDAR y no al mostrar, porque si se arreglara al mostrar
 * habría que acordarse de hacerlo en cada una de las pantallas y en cada mail,
 * y alcanzaría con una para que el nombre volviera a verse mal.
 *
 * ── LAS DOS COSAS QUE ESTO NO HACE ──────────────────────────────────────────
 *
 * 1. NO TOCA UNA PALABRA QUE YA TENGA UNA MAYÚSCULA. "McDonald", "DiCaprio",
 *    "O'Brien" y "LaValle" están escritos así a propósito por su dueño, y
 *    "normalizarlos" a "Mcdonald" sería corregirle el apellido a alguien que lo
 *    escribió bien. Solo se toca lo que está ENTERO en minúscula, que es el
 *    único caso en el que se sabe que nadie eligió nada.
 *
 * 2. NO LEVANTA LAS PARTÍCULAS. En castellano "de", "del", "la", "los", "van",
 *    "von", "da" y "di" van en minúscula cuando están en el medio: "Juan de la
 *    Cruz", no "Juan De La Cruz". Sí se levantan si son la primera palabra,
 *    porque ahí son el nombre ("Da Silva, Ana").
 *
 * Separa por espacios Y por guiones, así "ana-maria" queda "Ana-Maria" y no
 * "Ana-maria".
 */

/** Las que van en minúscula cuando están en el medio de un nombre. */
const PARTICULAS = new Set([
  "de",
  "del",
  "la",
  "las",
  "los",
  "da",
  "das",
  "do",
  "dos",
  "di",
  "van",
  "von",
  "der",
  "y",
  "e",
]);

/** Una sola palabra, ya sabiendo si es la primera. */
function palabra(texto: string, primera: boolean): string {
  if (texto.length === 0) return texto;
  // Ya tiene una mayúscula en algún lado: su dueño la escribió así.
  if (texto !== texto.toLowerCase()) return texto;
  if (!primera && PARTICULAS.has(texto)) return texto;
  return texto[0].toUpperCase() + texto.slice(1);
}

/**
 * El nombre o el apellido tal como se va a guardar.
 *
 * Además saca los espacios de los bordes y junta los repetidos del medio: un
 * "ignacio  britos" con dos espacios se ve mal en cualquier pantalla y no es
 * algo que nadie haya querido escribir.
 */
export function nombreProlijo(texto: string): string {
  const limpio = texto.trim().replace(/\s+/g, " ");
  if (limpio.length === 0) return limpio;

  let primeraPalabra = true;
  return limpio
    .split(" ")
    .map((parte) =>
      parte
        .split("-")
        .map((trozo) => {
          const salida = palabra(trozo, primeraPalabra);
          if (trozo.length > 0) primeraPalabra = false;
          return salida;
        })
        .join("-"),
    )
    .join(" ");
}

/**
 * Lo mismo, tolerando que no venga nada.
 *
 * Devuelve `undefined` cuando no hay texto para que quien llama pueda
 * reenviarlo tal cual a Prisma sin pisar un campo que nadie quiso cambiar.
 */
export function nombreProlijoOpcional(
  texto: string | null | undefined,
): string | undefined {
  if (typeof texto !== "string") return undefined;
  const salida = nombreProlijo(texto);
  return salida.length > 0 ? salida : undefined;
}
