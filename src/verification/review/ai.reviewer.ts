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
 * Deja un nombre comparable: sin acentos, en mayúsculas, sin puntuación y sin
 * las palabras cortas que no distinguen a nadie. Hace falta porque los dos
 * documentos casi nunca escriben el nombre igual: uno pone "PÉREZ, Juan Carlos"
 * y el otro "JUAN CARLOS PEREZ".
 */
function nameWords(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2);
}

/**
 * ¿Los dos nombres son de la misma persona?
 *
 * Se pide que todas las palabras del nombre más corto estén en el más largo: es
 * normal que un documento incluya un segundo nombre que el otro no trae, pero no
 * que aparezca un apellido distinto. Con menos de dos palabras en común no se
 * arriesga una conclusión.
 */
function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const first = nameWords(a);
  const second = nameWords(b);
  if (first.length < 2 || second.length < 2) return false;

  const [shorter, longer] =
    first.length <= second.length ? [first, second] : [second, first];
  const pool = new Set(longer);
  return shorter.every((word) => pool.has(word));
}

/** ¿La fecha (YYYY-MM-DD) ya pasó? Se compara por día, no por hora. */
function isExpired(date: string | null | undefined): boolean {
  if (!date) return false;
  const expires = new Date(`${date}T23:59:59.999Z`).getTime();
  if (Number.isNaN(expires)) return false;
  return expires < Date.now();
}

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
 * Además cruza los dos documentos: la licencia tiene que ser de la misma persona
 * que el DNI (mismo nombre, y en Argentina también el mismo número, porque la
 * licencia nacional lleva el número de DNI) y no puede estar vencida. Sin este
 * cruce alcanzaba con subir un DNI propio y una licencia de otra persona.
 *
 * Si la IA no está disponible (sin GROQ_API_KEY o error del servicio), la
 * solicitud queda PENDIENTE de que la mire un admin. Antes se aprobaba sin
 * revisar "para que un servicio externo no deje a las cuentas sin verificar", y
 * el resultado fue el contrario del buscado: el día que el modelo de Groq se dio
 * de baja, la revisión falló para todos y cualquier foto —una de un perro, por
 * ejemplo— quedaba aprobada como DNI. Vale más una cuenta esperando que una
 * verificación que no verificó nada.
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

    // Los datos de cada documento por separado, para poder cruzarlos. Antes se
    // guardaba "el primer nombre que se pudo leer" sin importar de qué foto
    // saliera, así que un DNI y una licencia de dos personas distintas pasaban
    // sin que nada lo notara.
    const fromDni = results.filter((r) => r.kind.startsWith("DNI"));
    const fromLicense = results.filter((r) => r.kind.startsWith("LICENSE"));
    const firstOf = <T>(
      list: typeof results,
      pick: (inspection: (typeof results)[number]["inspection"]) => T | null | undefined,
    ): T | null => list.map((r) => pick(r.inspection)).find(Boolean) ?? null;

    const dniName = firstOf(fromDni, (i) => i.fullName);
    const dniNumber = firstOf(fromDni, (i) => i.documentNumber);
    const licenseName = firstOf(fromLicense, (i) => i.fullName);
    const licenseNumber = firstOf(fromLicense, (i) => i.documentNumber);
    const licenseExpiresAt = firstOf(fromLicense, (i) => i.expiresAt);

    const extracted = {
      documentNumber: dniNumber,
      fullName: dniName ?? licenseName,
      licenseExpiresAt,
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

    // Sin IA no se aprueba: queda esperando a un admin. Aprobar acá era darle el
    // cartel de "identidad verificada" a algo que nadie miró.
    if (unavailable.length === results.length) {
      this.logger.warn(
        `AI review unavailable for ${input.verificationId}: queda pendiente de revisión manual`,
      );
      return {
        approved: false,
        pending: true,
        notes:
          "La revisión automática no está disponible (revisá GET /ai/health). " +
          "La solicitud queda pendiente de revisión manual.",
        extracted,
      };
    }

    // Cruce entre los dos documentos: tienen que ser de la misma persona.
    const mismatch = this.crossCheck({
      dniName,
      dniNumber,
      licenseName,
      licenseNumber,
      licenseExpiresAt,
    });
    if (mismatch) {
      this.logger.log(
        `Identity submission ${input.verificationId} rejected by cross-check: ${mismatch}`,
      );
      return { approved: false, notes: `Revisión automática: ${mismatch}`, extracted };
    }

    this.logger.log(
      `Identity submission ${input.verificationId} approved by AI review`,
    );
    return {
      approved: true,
      notes: `Revisión automática: las ${results.length - unavailable.length} fotos revisadas corresponden${
        dniName && licenseName ? " y la licencia es de la misma persona que el DNI" : ""
      }.`,
      extracted,
    };
  }

  /**
   * Compara DNI y licencia. Devuelve el motivo del rechazo, o null si está todo bien.
   *
   * Solo concluye con los datos que la IA realmente pudo leer: si de una de las
   * dos fotos no salió el nombre, no se inventa un rechazo por eso —la foto ya
   * pasó el control de "esto es una licencia"—, porque rechazar por un dato que no
   * se pudo leer deja afuera a gente con documentos perfectamente válidos.
   */
  private crossCheck(data: {
    dniName: string | null;
    dniNumber: string | null;
    licenseName: string | null;
    licenseNumber: string | null;
    licenseExpiresAt: string | null;
  }): string | null {
    if (isExpired(data.licenseExpiresAt)) {
      return `la licencia está vencida (venció el ${data.licenseExpiresAt}).`;
    }

    if (data.dniName && data.licenseName && !samePerson(data.dniName, data.licenseName)) {
      return (
        "el nombre de la licencia no coincide con el del DNI " +
        `("${data.licenseName}" contra "${data.dniName}"). ` +
        "Los dos documentos tienen que ser de la misma persona."
      );
    }

    // En Argentina la licencia nacional lleva el número de DNI, así que si los
    // dos números se leyeron y son distintos, no son de la misma persona.
    if (
      data.dniNumber &&
      data.licenseNumber &&
      data.dniNumber !== data.licenseNumber
    ) {
      return (
        `el número de la licencia (${data.licenseNumber}) no coincide con el del ` +
        `DNI (${data.dniNumber}).`
      );
    }

    return null;
  }
}
