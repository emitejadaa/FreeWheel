/**
 * El email de una cuenta, escrito siempre de la misma manera.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * `User.email` es único en la base, pero Postgres compara texto tal cual viene:
 * para la base `Ana@Gmail.com` y `ana@gmail.com` son dos valores distintos, así
 * que el índice único los dejaba convivir como DOS CUENTAS. Y no son dos
 * direcciones: el dominio es insensible a mayúsculas por RFC 1035 y ningún
 * proveedor real (Gmail, Outlook, iCloud) distingue mayúsculas en la parte
 * local. O sea que las dos cuentas recibían el correo en la misma casilla —
 * incluido el link para recuperar la contraseña de la otra—.
 *
 * Con esto, TODO email entra a la base en minúsculas y sin espacios al borde, y
 * el índice único que ya existía pasa a valer también para las mayúsculas.
 *
 * ── Lo que NO hace, a propósito ─────────────────────────────────────────────
 * No toca los alias con `+` (ana+autos@gmail.com) ni los puntos de Gmail. Son
 * direcciones distintas para el estándar, hay gente que las usa a propósito para
 * separar su correo, y colapsarlas dejaría afuera registros legítimos. Lo que se
 * unifica es la misma dirección escrita distinto, no direcciones parecidas.
 */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
