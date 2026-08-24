import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Los datos que identifican a UNA persona y que, por lo tanto, no pueden estar
 * repartidos entre dos cuentas.
 *
 * ── Por qué se listan acá y no en cada servicio ─────────────────────────────
 * La unicidad la garantiza la base (índices únicos en User), pero un índice
 * único contesta con un error de Prisma (P2002) que, sin traducir, sale como un
 * 500 y no le dice a nadie qué dato estaba repetido. Antes cada lugar que
 * escribía un usuario resolvía eso por su cuenta —el registro no lo resolvía en
 * absoluto—, así que el mismo choque daba un mensaje distinto según por dónde
 * entrara.
 *
 * Esta tabla es la lista de esos campos con el código y el texto que le
 * corresponde a cada uno. Los dos caminos —el pre-chequeo, que da un mensaje
 * claro, y la traducción del P2002, que cierra la carrera entre dos requests
 * simultáneos— salen de acá, así que siempre dicen lo mismo.
 */
export const UNIQUE_IDENTITY_FIELDS = {
  email: {
    code: "EMAIL_ALREADY_REGISTERED",
    message: "Ya hay una cuenta con ese email. Probá con otra dirección.",
  },
  phone: {
    code: "PHONE_ALREADY_REGISTERED",
    message: "Ya hay una cuenta con ese teléfono. Probá con otro número.",
  },
  dni: {
    code: "DNI_ALREADY_REGISTERED",
    message: "Ese DNI ya está asociado a otra cuenta",
  },
  cuil: {
    code: "CUIL_ALREADY_REGISTERED",
    message: "Ese CUIL ya está asociado a otra cuenta",
  },
  googleId: {
    code: "GOOGLE_ACCOUNT_ALREADY_LINKED",
    message: "Esa cuenta de Google ya está vinculada a otro usuario.",
  },
} as const;

export type UniqueIdentityField = keyof typeof UNIQUE_IDENTITY_FIELDS;

/** El 409 que corresponde a un campo repetido. */
export function identityConflict(
  field: UniqueIdentityField,
): ConflictException {
  const { code, message } = UNIQUE_IDENTITY_FIELDS[field];
  return new ConflictException({ statusCode: 409, code, message });
}

/**
 * Traduce el choque de un índice único de la base al mismo 409 que devuelve el
 * pre-chequeo. Devuelve null si el error es otra cosa, para que quien llama lo
 * vuelva a lanzar tal cual.
 *
 * Es lo que cubre la ventana entre "consulté y no había nadie" y "escribí": dos
 * registros con el mismo email al mismo tiempo pasan los dos el pre-chequeo, y
 * el que pierde la carrera tiene que enterarse por la base.
 */
export function identityConflictFromPrisma(
  error: unknown,
): ConflictException | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }

  // `target` trae las columnas del índice violado. Según el driver puede venir
  // como array de columnas o como el nombre del índice ("User_email_lower_key"),
  // así que se busca el campo ADENTRO del texto en vez de comparar de igual a
  // igual.
  const target: unknown = error.meta?.target;
  const columns = Array.isArray(target)
    ? target.map((column) => String(column)).join(",")
    : typeof target === "string"
      ? target
      : "";

  const field = (
    Object.keys(UNIQUE_IDENTITY_FIELDS) as UniqueIdentityField[]
  ).find((name) => columns.includes(name));

  return field ? identityConflict(field) : null;
}
