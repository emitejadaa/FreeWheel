import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";

export interface CurrentUserPayload {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  verificationStatus: VerificationStatus;
  dateOfBirth: Date | null;
  /**
   * Lo que decide si esta persona puede alquilar un auto en ESTE pedido.
   *
   * Viajan en el payload —y no se consultan cuando hacen falta— porque
   * JwtStrategy ya trae el usuario entero de la base en cada request: tenerlos
   * acá hace que el control no cueste una consulta más. Los completa la
   * lectura del documento al aprobar la licencia; en `null` significa "no se
   * sabe", que NO bloquea (ver driving-eligibility.ts).
   */
  licenseExpiresAt: Date | null;
  licenseClass: string | null;
  licenseBeginnerUntil: Date | null;
  /** Present only when the request was authenticated with an onboarding token. */
  tokenScope?: "onboarding";
}
