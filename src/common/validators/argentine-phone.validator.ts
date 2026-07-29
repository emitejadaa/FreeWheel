import { registerDecorator, ValidationOptions } from "class-validator";

/**
 * Teléfono argentino en formato internacional completo.
 *
 * El servicio funciona solo en Argentina, así que el número tiene que empezar
 * con el código de país 54. Un celular argentino en formato internacional es:
 *
 *     54  9   11      3289 5416
 *     ↑   ↑   ↑       ↑
 *     país│   área    número
 *         └ el 9 identifica que es un celular
 *
 * Después del 54 van siempre 10 dígitos entre área y número (11 + 8 en CABA,
 * 351 + 7 en Córdoba, 2954 + 6 en La Pampa: cambia el reparto, no el total).
 *
 * Antes el campo aceptaba cualquier texto de hasta 32 caracteres, así que "123"
 * entraba y quedaba guardado: un dato inútil con el que nunca se va a poder
 * mandar un código de verificación.
 */

/** Cantidad de dígitos de área + número en Argentina. */
const LOCAL_DIGITS = 10;
const COUNTRY_CODE = "54";

/**
 * Deja el número en formato canónico E.164 `+549XXXXXXXXXX` o devuelve null si
 * no es un teléfono argentino válido. El `+` va incluido porque es el formato
 * internacional y es el que ya venía guardando la base.
 *
 * Acepta cómo lo escriba la persona: con +, con espacios, con guiones o con
 * paréntesis. Si viene sin el 9 de celular (54 11 3289 5416) se lo agrega, que
 * es lo que hace falta para poder llamar o mandar un SMS desde afuera del país.
 */
export function normalizeArgentinePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;

  // Se conservan solo los dígitos; el prefijo puede venir como "+54" o "0054".
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);

  if (!digits.startsWith(COUNTRY_CODE)) return null;

  let rest = digits.slice(COUNTRY_CODE.length);

  // El 0 de larga distancia nacional (011) y el 15 de celular no van en el
  // formato internacional.
  if (rest.startsWith("0")) rest = rest.slice(1);

  // Ya trae el 9 de celular.
  if (rest.length === LOCAL_DIGITS + 1 && rest.startsWith("9")) {
    return `+${COUNTRY_CODE}${rest}`;
  }

  // Vino sin el 9: se agrega.
  if (rest.length === LOCAL_DIGITS) {
    return `+${COUNTRY_CODE}9${rest}`;
  }

  return null;
}

/** ¿Es un teléfono argentino válido? */
export function isArgentinePhone(value: unknown): boolean {
  return normalizeArgentinePhone(value) !== null;
}

/**
 * Formatea para mostrar: `54 9 11 3289 5416`. Recibe cualquier formato válido y
 * devuelve el original si no se pudo interpretar.
 */
export function formatArgentinePhone(value: unknown): string {
  const normalized = normalizeArgentinePhone(value);
  if (!normalized) return typeof value === "string" ? value : "";

  // +54 | 9 | resto (10 dígitos, se parte 2 + 4 + 4 para que se lea cómodo)
  const rest = normalized.slice(4);
  return `+54 9 ${rest.slice(0, 2)} ${rest.slice(2, 6)} ${rest.slice(6)}`;
}

/** class-validator decorator para los campos de teléfono de los DTO. */
export function IsArgentinePhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isArgentinePhone",
      target: object.constructor,
      propertyName,
      options: {
        message:
          "El teléfono debe ser argentino y estar completo, con el código de país: 54 9 11 3289 5416",
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) => isArgentinePhone(value),
      },
    });
  };
}
