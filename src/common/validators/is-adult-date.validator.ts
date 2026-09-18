import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";
import { esLaCuentaDePrueba } from "../cuenta-de-prueba";

const MIN_AGE_YEARS = 18;
const MAX_AGE_YEARS = 120;

/**
 * FASE DE PRUEBA · borrar junto con cuenta-de-prueba.ts.
 *
 * La cuenta de prueba de la demo tiene 17 años, así que con el límite normal no
 * llega ni a registrarse y no hay nada que probar. Baja a 17 y no a cero: sigue
 * siendo un límite, solo que uno que esa cuenta cumple.
 */
const MIN_AGE_YEARS_CUENTA_DE_PRUEBA = 17;

/**
 * Strict `YYYY-MM-DD` birth-date check: real calendar date (round-trips through
 * Date, so 2000-02-31 is rejected), age >= 18 and <= 120, computed in UTC so the
 * server timezone can never shift someone across the boundary.
 *
 * `email` solo existe por la cuenta de prueba de la fase de demo: sin él, o con
 * el de cualquier otra persona, el mínimo son 18 como siempre. Lo demás —que la
 * fecha exista, el tope de 120— no se afloja para nadie.
 */
export function isAdultDate(value: unknown, email?: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  if (date.toISOString().slice(0, 10) !== value) return false;

  const now = new Date();
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - date.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < date.getUTCDate())
  ) {
    age -= 1;
  }

  const minimo =
    typeof email === "string" && esLaCuentaDePrueba(email)
      ? MIN_AGE_YEARS_CUENTA_DE_PRUEBA
      : MIN_AGE_YEARS;

  return age >= minimo && age <= MAX_AGE_YEARS;
}

/** class-validator decorator for DTO fields carrying an adult birth date. */
export function IsAdultDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isAdultDate",
      target: object.constructor,
      propertyName,
      options: {
        message:
          "dateOfBirth debe ser una fecha válida (YYYY-MM-DD) de una persona mayor de 18 años",
        ...validationOptions,
      },
      validator: {
        // El email sale del MISMO objeto que se está validando, así que esto
        // solo alcanza a los DTO que lo traen —el alta con mail y contraseña—.
        // `CompleteProfileDto` (alta con Google) no lo tiene: ahí el mail viene
        // del token y este validador no lo ve, así que ese camino sigue
        // pidiendo 18.
        validate: (value: unknown, args?: ValidationArguments) =>
          isAdultDate(value, (args?.object as { email?: unknown })?.email),
      },
    });
  };
}
