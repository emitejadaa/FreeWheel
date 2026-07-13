import { registerDecorator, ValidationOptions } from "class-validator";

const MIN_AGE_YEARS = 18;
const MAX_AGE_YEARS = 120;

/**
 * Strict `YYYY-MM-DD` birth-date check: real calendar date (round-trips through
 * Date, so 2000-02-31 is rejected), age >= 18 and <= 120, computed in UTC so the
 * server timezone can never shift someone across the boundary.
 */
export function isAdultDate(value: unknown): boolean {
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

  return age >= MIN_AGE_YEARS && age <= MAX_AGE_YEARS;
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
        validate: (value: unknown) => isAdultDate(value),
      },
    });
  };
}
