import { registerDecorator, ValidationOptions } from "class-validator";
import { isValidPersonCuil } from "../utils/cuil.util";

/**
 * class-validator decorator para campos que llevan un CUIL/CUIT de persona
 * física: acepta con o sin guiones, exige prefijo de persona y checksum
 * mod-11 válido. La consistencia CUIL↔DNI se chequea en el servicio (necesita
 * el otro campo).
 */
export function IsCuil(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isCuil",
      target: object.constructor,
      propertyName,
      options: {
        message:
          "cuil debe ser un CUIL/CUIT de persona válido (XX-XXXXXXXX-X con dígito verificador correcto)",
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" && isValidPersonCuil(value),
      },
    });
  };
}
