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
  field: "dniFrontUrl" | "dniBackUrl" | "licenseFrontUrl" | "licenseBackUrl";
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
 * Es el modo IDENTITY_REVIEW_MODE=ai. Más liviano que document_ai: no decodifica
 * el PDF417 ni el MRZ ni cruza los datos contra los de la cuenta, pero alcanza
 * para impedir que se suba una foto cualquiera. Además extrae los datos visibles
 * (número, nombre y vencimiento) para que queden registrados en la base.
 *
 * Cuando la IA no puede revisar, el caso queda INCONCLUSO y pasa a la cola del
 * admin. Aprobar sin haber mirado sería exactamente el agujero que este modo
 * existe para tapar: con el proveedor caído, cualquier imagen entraría.
 */
export class AiIdentityReviewer implements IdentityReviewer {
  readonly name = "ai";

  private readonly logger = new Logger(AiIdentityReviewer.name);

  constructor(private readonly ai: AiService) {}

  async review(input: IdentityReviewInput): Promise<IdentityReviewVerdict> {
    const results = await Promise.all(
      CHECKS.map(async (check) => {
        const url = input[check.field];
        const inspection = await this.ai.inspectDocument(url, check.kind);
        return { ...check, inspection };
      }),
    );

    const rejected = results.filter((r) => r.inspection.matches === false);
    const unavailable = results.filter((r) => r.inspection.matches === null);

    // Datos extraídos: el número y el nombre salen del DNI, el vencimiento de la
    // licencia. Se quedan con el primer valor que la IA pudo leer.
    const documentNumber =
      results.find(
        (r) => r.kind.startsWith("DNI") && r.inspection.documentNumber,
      )?.inspection.documentNumber ?? null;
    const fullName =
      results.find((r) => r.inspection.fullName)?.inspection.fullName ?? null;
    const licenseExpiresAt =
      results.find(
        (r) => r.kind.startsWith("LICENSE") && r.inspection.expiresAt,
      )?.inspection.expiresAt ?? null;

    const promoted = {
      extracted: { documentNumber, fullName, licenseExpiresAt },
      ...(documentNumber ? { documentNumber } : {}),
      ...(fullName ? { fullNameOnDocument: fullName } : {}),
      ...(licenseExpiresAt
        ? { licenseExpiresAt: new Date(`${licenseExpiresAt}T00:00:00.000Z`) }
        : {}),
    };

    if (rejected.length > 0) {
      const detail = rejected
        .map((r) => `${r.label}: ${r.inspection.reason}`)
        .join(" | ");
      this.logger.log(
        `Identity submission ${input.verificationId} rejected by AI review (${rejected.length} fotos)`,
      );
      return {
        outcome: "rejected",
        reasonCodes: ["AI_DOCUMENT_MISMATCH"],
        notes: `Revisión automática: fotos que no corresponden. ${detail}`,
        ...promoted,
      };
    }

    if (unavailable.length > 0) {
      this.logger.warn(
        `AI review incompleta para ${input.verificationId}: ${unavailable.length} de ${results.length} fotos sin revisar, queda para el admin`,
      );
      return {
        outcome: "inconclusive",
        reasonCodes:
          unavailable.length === results.length
            ? ["AI_UNAVAILABLE"]
            : ["AI_PARTIALLY_UNAVAILABLE"],
        notes: `Revisión automática incompleta (${unavailable.length} de ${results.length} fotos): queda pendiente de revisión manual.`,
        ...promoted,
      };
    }

    this.logger.log(
      `Identity submission ${input.verificationId} approved by AI review`,
    );
    return {
      outcome: "approved",
      reasonCodes: [],
      notes: `Revisión automática: las ${results.length} fotos revisadas corresponden.`,
      ...promoted,
    };
  }
}
