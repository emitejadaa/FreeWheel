import { Prisma } from "@prisma/client";
import { IdentityProfileSnapshot } from "../matching/identity-match.service";

/**
 * Seam para el paso de revisión de documentos. Los callers solo hablan con
 * IdentityReviewService; qué reviewer corre detrás lo decide la env
 * IDENTITY_REVIEW_MODE (auto_approve | manual | document_ai), espejando el
 * patrón de providers de pagos/SMS.
 */

export const IDENTITY_REVIEWER = Symbol("IDENTITY_REVIEWER");

/**
 * Tres resultados, no dos: además de aprobar o rechazar, un reviewer puede
 * no llegar a una conclusión (código ilegible, foto borrosa, proveedor
 * caído). Ese caso NO rechaza a la persona: queda pendiente para la cola de
 * revisión manual del admin.
 */
export type IdentityReviewOutcome = "approved" | "rejected" | "inconclusive";

export type { IdentityProfileSnapshot };

export interface IdentityReviewInput {
  userId: string;
  verificationId: string;
  dniFrontUrl: string;
  dniBackUrl: string;
  licenseFrontUrl: string;
  licenseBackUrl: string;
  /**
   * Datos cargados a mano en la cuenta contra los que se cruzan los
   * documentos. Van en el input para que el reviewer no necesite Prisma.
   */
  profile: IdentityProfileSnapshot;
}

export interface IdentityReviewVerdict {
  outcome: IdentityReviewOutcome;
  /** Códigos estables, sin PII: se le pueden mostrar al usuario. */
  reasonCodes: string[];
  /** Resumen corto para el admin; nunca un volcado de datos personales. */
  notes?: string;
  /** Extracción por fuente y reporte de cruces (PII: solo para admins). */
  extracted?: Prisma.InputJsonValue;
  matchReport?: Prisma.InputJsonValue;
  /** Escalares promovidos para consultas y antifraude. */
  dniNumber?: string;
  licenseExpiresAt?: Date;
}

export interface IdentityReviewer {
  readonly name: string;
  review(input: IdentityReviewInput): Promise<IdentityReviewVerdict>;
}
