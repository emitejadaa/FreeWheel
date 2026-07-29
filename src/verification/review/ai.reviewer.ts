import { Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import type { DocumentKind } from "../../ai/ai.service";
import {
  IdentityReviewer,
  IdentityReviewInput,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

/** Cada foto enviada, con el tipo de documento que debería mostrar. */
const CHECKS: {
  kind: DocumentKind;
  field: keyof IdentityReviewInput;
  label: string;
}[] = [
  { kind: "DNI_FRONT", field: "dniFrontUrl", label: "frente del DNI" },
  { kind: "DNI_BACK", field: "dniBackUrl", label: "dorso del DNI" },
  {
    kind: "LICENSE_FRONT",
    field: "licenseFrontUrl",
    label: "frente de la licencia",
  },
  {
    kind: "LICENSE_BACK",
    field: "licenseBackUrl",
    label: "dorso de la licencia",
  },
];

/**
 * Revisión de identidad con IA: mira las cuatro fotos y aprueba solo si cada una
 * es realmente el documento que corresponde.
 *
 * Es el modo IDENTITY_REVIEW_MODE=ai. A diferencia de auto_approve (que aprueba
 * cualquier cosa con tal de que haya cuatro archivos), acá no se puede subir una
 * foto cualquiera: si alguna no es un DNI o una licencia, la verificación queda
 * rechazada con el motivo.
 *
 * Además extrae los datos visibles (número de documento, nombre y vencimiento)
 * para que queden registrados en la base y no dependan de lo que escriba el
 * usuario.
 *
 * Si la IA no está disponible (sin GROQ_API_KEY o error del servicio), no
 * bloquea: aprueba y lo deja anotado, para que la falta de un servicio externo no
 * deje a todas las cuentas sin verificar.
 */
export class AiIdentityReviewer implements IdentityReviewer {
  readonly name = "ai";

  private readonly logger = new Logger(AiIdentityReviewer.name);

  constructor(private readonly ai: AiService) {}

  async review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    const results = await Promise.all(
      CHECKS.map(async (check) => {
        const url = input[check.field] as string;
        const inspection = await this.ai.inspectDocument(url, check.kind);
        return { ...check, inspection };
      }),
    );

    const rejected = results.filter((r) => r.inspection.matches === false);
    const unavailable = results.filter((r) => r.inspection.matches === null);

    // Datos extraídos: el número y el nombre salen del DNI, el vencimiento de la
    // licencia. Se quedan con el primer valor que la IA pudo leer.
    const extracted = {
      documentNumber:
        results.find(
          (r) => r.kind.startsWith("DNI") && r.inspection.documentNumber,
        )?.inspection.documentNumber ?? null,
      fullName:
        results.find((r) => r.inspection.fullName)?.inspection.fullName ?? null,
      licenseExpiresAt:
        results.find(
          (r) => r.kind.startsWith("LICENSE") && r.inspection.expiresAt,
        )?.inspection.expiresAt ?? null,
    };

    if (rejected.length > 0) {
      const detail = rejected
        .map((r) => `${r.label}: ${r.inspection.reason}`)
        .join(" | ");
      this.logger.log(
        `Identity submission ${input.verificationId} rejected by AI review (${rejected.length} fotos)`,
      );
      return {
        approved: false,
        notes: `Revisión automática: fotos que no corresponden. ${detail}`,
        extracted,
      };
    }

    if (unavailable.length === results.length) {
      this.logger.warn(
        `AI review unavailable for ${input.verificationId}: se aprueba sin revisar`,
      );
      return {
        approved: true,
        notes:
          "Revisión automática no disponible: aprobado sin verificar las imágenes.",
        extracted,
      };
    }

    this.logger.log(
      `Identity submission ${input.verificationId} approved by AI review`,
    );
    return {
      approved: true,
      notes: `Revisión automática: las ${results.length - unavailable.length} fotos revisadas corresponden.`,
      extracted,
    };
  }
}
