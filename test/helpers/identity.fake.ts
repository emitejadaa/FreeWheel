import {
  DniBackResult,
  DniFrontResult,
  DocumentSlot,
  DocverifyResponse,
  LicenseBackResult,
  LicenseFrontResult,
} from "../../src/verification/docverify/docverify.types";
import { PythonDocverifyService } from "../../src/verification/docverify/python-docverify.service";

/**
 * Identidad sintética coherente: a partir de estos datos el fake del
 * verificador Python arma el contrato completo (OCR, PDF417 y MRZ) como si
 * las fotos se hubieran leído perfectas. Permite ejercitar el flujo entero
 * en E2E sin una sola foto real y sin Python instalado.
 */
export interface IdentityPersona {
  dni: string;
  firstName: string;
  lastName: string;
  /** ISO YYYY-MM-DD */
  birthDate: string;
  sex: "M" | "F";
  cuil: string;
  address: string;
  /** ISO YYYY-MM-DD */
  dniExpiry: string;
  /** ISO YYYY-MM-DD */
  licenseExpiry: string;
  issueDate: string;
  esPrincipiante: boolean;
  /** ISO YYYY-MM-DD, solo si esPrincipiante. */
  finPrincipiante: string | null;
}

export function personaFor(
  overrides: Partial<IdentityPersona> & Pick<IdentityPersona, "dni" | "cuil">,
): IdentityPersona {
  return {
    firstName: "JUAN CARLOS",
    lastName: "PEREZ",
    birthDate: "1990-02-01",
    sex: "M",
    address: "Av. Siempre Viva 742, Springfield, CABA",
    dniExpiry: "2035-02-15",
    licenseExpiry: "2031-05-20",
    issueDate: "2015-03-05",
    esPrincipiante: false,
    finPrincipiante: null,
    ...overrides,
  };
}

/** El contrato completo que devolvería el verificador para esta persona. */
export function docverifyResponseFor(
  persona: IdentityPersona,
  slots: DocumentSlot[],
): DocverifyResponse {
  const dniFront: DniFrontResult = {
    ocr: {
      title: "ocr",
      apellido: persona.lastName,
      nombre: persona.firstName,
      sexo: persona.sex,
      nDocumento: persona.dni,
      fechaNacimiento: persona.birthDate,
      fechaEmision: persona.issueDate,
      fechaVencimiento: persona.dniExpiry,
    },
    codigo: {
      title: "codigo",
      apellido: persona.lastName,
      nombre: persona.firstName,
      sexo: persona.sex,
      nDocumento: persona.dni,
      fechaNacimiento: persona.birthDate,
      fechaEmision: persona.issueDate,
    },
  };
  const dniBack: DniBackResult = {
    ocr: { title: "ocr", domicilio: persona.address, cuil: persona.cuil },
    mrz: {
      title: "mrz",
      apellido: persona.lastName,
      nombre: persona.firstName,
      sexo: persona.sex,
      nDocumento: persona.dni,
      fechaNacimiento: persona.birthDate,
      fechaVencimiento: persona.dniExpiry,
    },
  };
  const licenseFront: LicenseFrontResult = {
    ocr: {
      title: "ocr",
      numLicencia: persona.dni,
      apellido: persona.lastName,
      nombre: persona.firstName,
      domicilio: persona.address,
      fechaNacimiento: persona.birthDate,
      fechaVencimiento: persona.licenseExpiry,
    },
  };
  const licenseBack: LicenseBackResult = {
    ocr: {
      title: "ocr",
      cuil: persona.cuil,
      esPrincipiante: persona.esPrincipiante,
      finPrincipiante: persona.finPrincipiante,
    },
  };

  const all = {
    dni_front: dniFront,
    dni_back: dniBack,
    license_front: licenseFront,
    license_back: licenseBack,
  };

  return {
    ok: true,
    version: "test",
    documentos: Object.fromEntries(
      slots.map((slot) => [slot, all[slot]]),
    ) as DocverifyResponse["documentos"],
  };
}

type Mutator = (response: DocverifyResponse) => void;

/**
 * Reemplaza a PythonDocverifyService en los E2E: devuelve el contrato de la
 * persona configurada, sin ejecutar ningún subproceso. `mutate` deja romper
 * campos puntuales para probar los motivos de fallo.
 */
export class FakePythonDocverifyService {
  persona: IdentityPersona | null = null;
  private mutators: Mutator[] = [];
  private failure: Error | null = null;
  /** Con qué slots se llamó cada vez, para asertar el flujo. */
  readonly calls: DocumentSlot[][] = [];

  usePersona(persona: IdentityPersona): void {
    this.persona = persona;
  }

  /**
   * Hace que el verificador explote, para probar qué pasa cuando el Python se
   * muere o el verificador remoto no contesta.
   *
   * Existe para que NO haya que pisar `analyze` a mano. Cuando un test hacía
   * `docverify.analyze = () => Promise.reject(...)`, el parche quedaba puesto
   * para siempre —`reset()` no lo deshacía— y TODOS los tests declarados
   * después recibían un verificador roto sin enterarse. Esto lo limpia
   * `reset()` como todo lo demás.
   */
  failWith(error: Error): void {
    this.failure = error;
  }

  /**
   * Rompe campos puntuales de las respuestas que vengan (p. ej. borrar un
   * campo o meter un error).
   *
   * Queda puesto hasta que se lo saque: se aplica a TODAS las llamadas
   * siguientes, no solo a la próxima. Para un test que manda dos veces y
   * espera que la segunda salga bien, `clearMutators()`.
   */
  mutate(mutator: Mutator): void {
    this.mutators.push(mutator);
  }

  /** Saca los mutadores y deja la persona: la próxima respuesta sale perfecta. */
  clearMutators(): void {
    this.mutators = [];
  }

  reset(): void {
    this.persona = null;
    this.mutators = [];
    this.failure = null;
    this.calls.length = 0;
  }

  private instalado = true;

  /** Simula un servidor sin verificador (Vercel serverless: sin Python). */
  makeUnavailable(): void {
    this.instalado = false;
  }

  available(): Promise<boolean> {
    return Promise.resolve(this.instalado);
  }

  unavailableReason(): string {
    return "no hay verificador de documentos configurado (test)";
  }

  probe(): Promise<{
    transport: "remote" | "local" | "none";
    reachable: boolean;
    detail: string;
    remoteHealth: unknown;
  }> {
    return Promise.resolve({
      transport: "local" as const,
      reachable: true,
      detail: "verificador falso (tests)",
      remoteHealth: null,
    });
  }

  analyze(
    images: Partial<Record<DocumentSlot, Uint8Array>>,
  ): Promise<DocverifyResponse> {
    const slots = Object.keys(images) as DocumentSlot[];
    this.calls.push(slots);
    if (this.failure) return Promise.reject(this.failure);
    if (!this.persona) {
      throw new Error(
        "FakePythonDocverifyService: llamá a usePersona() antes del submit",
      );
    }
    const response = docverifyResponseFor(this.persona, slots);
    for (const mutator of this.mutators) mutator(response);
    return Promise.resolve(response);
  }

  /** Tipado para .overrideProvider(PythonDocverifyService).useValue(fake). */
  asService(): PythonDocverifyService {
    return this as unknown as PythonDocverifyService;
  }
}
