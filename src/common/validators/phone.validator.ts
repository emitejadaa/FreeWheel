import { registerDecorator, ValidationOptions } from "class-validator";
import {
  isArgentinePhone,
  normalizeArgentinePhone,
} from "./argentine-phone.validator";

/**
 * Teléfono en formato internacional E.164, de cualquier país.
 *
 * ANTES SOLO ENTRABAN NÚMEROS ARGENTINOS. El servicio funciona en Argentina, así
 * que el teléfono tenía que empezar con 54 y cualquier otro quedaba rechazado en
 * el registro y al editar el perfil. Eso deja afuera justamente a quien más
 * necesita alquilar un auto acá: alguien que llega de afuera, con el teléfono de
 * su país y todavía sin línea argentina. La aplicación está traducida a cinco
 * idiomas para que la usen extranjeros y después les pedía un celular argentino
 * en el primer formulario.
 *
 * QUÉ SE VALIDA Y QUÉ NO
 * Argentina se sigue validando en serio, con la regla de siempre: después del 54
 * van 10 dígitos entre área y número, más el 9 que identifica al celular. Esa
 * regla la conocemos y sirve para no guardar un número con el que después no se
 * puede mandar ningún código.
 *
 * Del resto de los países se comprueba el largo y nada más. No se inventa una
 * regla por país: no las sabemos, y una regla inventada rechaza números buenos,
 * que es peor que aceptar uno malo. E.164 admite hasta 15 dígitos contando el
 * código de país, y por abajo se corta en 7 en total, que ya es más corto que
 * cualquier número nacional real.
 */

/** Largo máximo de un número E.164, contando el código de país. */
const E164_MAX = 15;
/** Mínimo total; por debajo de esto es un descuido, no un teléfono. */
const E164_MIN = 7;

/**
 * Deja el número en formato canónico E.164 (`+` y solo dígitos) o devuelve null.
 *
 * Acepta cómo lo escriba la persona: con +, con 00 adelante, con espacios, con
 * guiones o con paréntesis.
 */
export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let digits = value.replace(/\D/g, "");
  // El prefijo internacional puede venir como "+54" o como "0054".
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;

  // Argentina pasa por la regla estricta: es la que sabemos y la que ya estaba.
  if (digits.startsWith("54")) return normalizeArgentinePhone(digits);

  if (digits.length < E164_MIN || digits.length > E164_MAX) return null;
  return `+${digits}`;
}

/** ¿Es un teléfono internacional válido? */
export function isPhone(value: unknown): boolean {
  return normalizePhone(value) !== null;
}

/** class-validator decorator para los campos de teléfono de los DTO. */
export function IsPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isPhone",
      target: object.constructor,
      propertyName,
      options: {
        message:
          "El teléfono debe estar completo y con el código de país: +54 9 11 3289 5416, +34 612 345 678, +55 11 91234 5678",
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) => isPhone(value),
      },
    });
  };
}

export { isArgentinePhone };
