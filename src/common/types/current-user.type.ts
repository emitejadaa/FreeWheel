import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";

export interface CurrentUserPayload {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  verificationStatus: VerificationStatus;
  dateOfBirth: Date | null;
  /**
   * Lo que decide, en ESTE pedido, qué puede hacer esta persona.
   *
   * Viajan en el payload —y no se consultan cuando hacen falta— porque
   * JwtStrategy ya trae el usuario entero de la base en cada request: tenerlos
   * acá hace que el control no cueste una consulta más.
   *
   * Los DECLARÓ su dueño al enviar cada documento, y la lectura de la foto los
   * corroboró antes de aprobarlo. En `null` significa "no se sabe", que NO
   * bloquea (ver driving-eligibility.ts).
   *
   * Los de licencia gobiernan alquilar un auto; `dniExpiresAt` gobierna todo lo
   * demás que sea sensible.
   */
  licenseExpiresAt: Date | null;
  licenseClass: string | null;
  licenseBeginnerUntil: Date | null;
  dniExpiresAt: Date | null;
  /** Present only when the request was authenticated with an onboarding token. */
  tokenScope?: "onboarding";
}
