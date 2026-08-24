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
  /** Con qué slots se llamó cada vez, para asertar el flujo. */
  readonly calls: DocumentSlot[][] = [];

  usePersona(persona: IdentityPersona): void {
    this.persona = persona;
  }

  /** Ajusta la próxima respuesta (p. ej. borrar un campo o meter un error). */
  mutate(mutator: Mutator): void {
    this.mutators.push(mutator);
  }

  reset(): void {
    this.persona = null;
    this.mutators = [];
    this.calls.length = 0;
  }

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  analyze(
    images: Partial<Record<DocumentSlot, Uint8Array>>,
  ): Promise<DocverifyResponse> {
    const slots = Object.keys(images) as DocumentSlot[];
    this.calls.push(slots);
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
