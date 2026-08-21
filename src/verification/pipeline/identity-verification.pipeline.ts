import { Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/utils/with-timeout.util";
import {
  VerificationError,
  describeError,
  verificationError,
} from "../errors/verification-errors";
import {
  CodeExtraction,
  CodeExtractionService,
  DocumentCodesRead,
  SlotImageSource,
} from "../extraction/code-extraction.service";
import { DocumentOcrService } from "../extraction/document-ocr.service";
import { DniBarcodeData } from "../extraction/dni-pdf417.parser";
import {
  DocumentExtraction,
  DocumentSlot,
} from "../extraction/extraction.types";
import { LicenseCodeData } from "../extraction/license-code.parser";
import { MrzData, tryParseMrzTd1 } from "../extraction/mrz-td1.parser";
import { toOcrExtraction } from "../extraction/ocr/ocr-response.parser";
import { OcrDocumentRead } from "../extraction/ocr/ocr.types";
import {
  IdentityMatchService,
  IdentityProfileSnapshot,
  MatchReport,
} from "../matching/identity-match.service";

const SLOTS: DocumentSlot[] = [
  "dni_front",
  "dni_back",
  "license_front",
  "license_back",
];

/**
 * Presupuesto de tiempo para leer el texto de las cuatro fotos.
 *
 * Es la etapa que depende de un proveedor externo y la única que puede tardar
 * de forma imprevisible. Al agotarse, el pipeline sigue sin ella: el PDF417 y
 * los datos del formulario alcanzan para decidir, y perder el texto impreso
 * cuesta corroboración, no la verificación entera.
 */
export const OCR_BUDGET_MS = 25_000;

/** Cómo conseguir los bytes de una foto. */
export interface SlotImages {
  /** Variantes a probar buscando el código, en orden de preferencia. */
  codeVariants: (string | undefined)[];
  /** La variante que se usa para leer el texto (más liviana). */
  ocrVariant: string | undefined;
  load(
    variant: string | undefined,
  ): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface PipelineInput {
  profile: IdentityProfileSnapshot;
  images: Partial<Record<DocumentSlot, SlotImages>>;
  now?: Date;
  /** Pedirle al modelo dónde está cada dato. Solo lo usa el diagnóstico. */
  withBoxes?: boolean;
  /** Cuánto esperar por el texto impreso antes de seguir sin él. */
  ocrBudgetMs?: number;
}

/** Una etapa del proceso, con lo que tardó y lo que pasó. */
export interface StageResult {
  stage: string;
  status: "ok" | "skipped" | "failed";
  durationMs: number;
  error?: VerificationError;
  note?: string;
}

export interface PipelineResult {
  /** Versión del formato. Las filas anteriores no lo tienen. */
  schema: 2;
  /** Lo que consume el cruce, en el formato de siempre. */
  extraction: DocumentExtraction;
  /** La lectura completa de cada foto, con evidencia. */
  reads: Partial<Record<DocumentSlot, OcrDocumentRead>>;
  dniCode: CodeExtraction<DniBarcodeData>;
  licenseCode: CodeExtraction<LicenseCodeData>;
  mrz: { data: MrzData | null; error?: VerificationError };
  report: MatchReport;
  stages: StageResult[];
  totalMs: number;
}

/** Lo que se puede sacar de UNA foto suelta, para el diagnóstico. */
export interface SingleDocumentResult {
  slot: DocumentSlot;
  codes: DocumentCodesRead;
  ocr: OcrDocumentRead | null;
  ocrError?: VerificationError;
  mrz?: { data: MrzData | null; error?: VerificationError };
  stages: StageResult[];
  totalMs: number;
}

/**
 * EL PEGAMENTO DE LOS TRES MÓDULOS
 *
 * Corre la lectura de códigos (módulo 2), la lectura del texto (módulo 1) y la
 * comparación (módulo 3), y deja registrado qué pasó en cada paso: cuánto
 * tardó, si salió bien, y si no, por qué. Ese registro es la diferencia entre
 * "la verificación no anduvo" y "el PDF417 se leyó en 400 ms, el OCR del dorso
 * se quedó sin modelo y el domicilio no coincide".
 *
 * No decide nada: la política está en IdentityMatchService y la lectura en
 * cada módulo. Acá solo se ordena el trabajo y se mide.
 */
@Injectable()
export class IdentityVerificationPipeline {
  private readonly logger = new Logger(IdentityVerificationPipeline.name);

  constructor(
    private readonly codes: CodeExtractionService,
    private readonly ocr: DocumentOcrService,
    private readonly matcher: IdentityMatchService,
  ) {}

  async run(input: PipelineInput): Promise<PipelineResult> {
    const started = Date.now();
    const stages: StageResult[] = [];

    // Los códigos y el texto no dependen entre sí: van en paralelo. El MRZ sí
    // depende del OCR del dorso, así que se parsea después.
    const [dniCode, licenseCode, reads] = await Promise.all([
      this.stage(stages, "codigos:dni", () =>
        this.codes.extractDniCode(
          // El PDF417 del DNI está en el frente; el dorso se mira igual porque
          // hay ejemplares que lo traen del otro lado.
          this.sourcesFor(input, ["dni_front", "dni_back"]),
        ),
      ),
      this.stage(stages, "codigos:licencia", () =>
        this.codes.extractLicenseCode(
          this.sourcesFor(input, ["license_back", "license_front"]),
        ),
      ),
      this.readAllText(input, stages),
    ]);

    const mrz = this.parseMrz(reads.dni_back, stages);

    const ocrPlano: DocumentExtraction["ocr"] = {};
    for (const slot of SLOTS) {
      const read = reads[slot];
      ocrPlano[slot] = read ? toOcrExtraction(read) : null;
    }

    const extraction: DocumentExtraction = {
      dniBarcode: dniCode.data,
      mrz: mrz.data,
      licenseCode: licenseCode.data,
      ocr: ocrPlano,
      schema: 2,
    };

    const report = await this.stage(stages, "comparacion", () =>
      Promise.resolve(
        this.matcher.match(input.profile, extraction, input.now ?? new Date()),
      ),
    );

    return {
      schema: 2,
      extraction,
      reads,
      dniCode,
      licenseCode,
      mrz,
      report,
      stages,
      totalMs: Date.now() - started,
    };
  }

  /**
   * Todo lo que se puede sacar de una sola foto ya cargada en memoria: los
   * códigos que trae y el texto que se le lee. Es lo que necesita el
   * diagnóstico para poder mirar una foto a la vez.
   */
  async runSingle(
    slot: DocumentSlot,
    bytes: Uint8Array,
    mimeType = "image/jpeg",
    options: { withBoxes?: boolean } = {},
  ): Promise<SingleDocumentResult> {
    const started = Date.now();
    const stages: StageResult[] = [];

    const [codes, lectura] = await Promise.all([
      this.stage(stages, `codigos:${slot}`, () =>
        this.codes.readCodes(slot, bytes),
      ),
      this.stage(stages, `texto:${slot}`, () =>
        this.ocr.read(slot, bytes, mimeType, options),
      ),
    ]);

    const result: SingleDocumentResult = {
      slot,
      codes,
      ocr: lectura.ok ? lectura.data : null,
      ...(lectura.ok ? {} : { ocrError: lectura.error }),
      stages,
      totalMs: Date.now() - started,
    };

    if (slot === "dni_back" && lectura.ok) {
      result.mrz = this.parseMrz(lectura.data, stages);
    }

    return result;
  }

  /** Las fotos donde buscar un código, en orden, salteando las que no están. */
  private sourcesFor(
    input: PipelineInput,
    slots: DocumentSlot[],
  ): SlotImageSource[] {
    return slots.flatMap((slot) => {
      const images = input.images[slot];
      if (!images) return [];
      return [
        {
          slot,
          variants: images.codeVariants,
          load: (variant) => images.load(variant),
        },
      ];
    });
  }

  /**
   * El texto de las cuatro fotos, en paralelo y con presupuesto de tiempo.
   * Si se agota, se sigue sin él: es la parte prescindible.
   */
  private readAllText(
    input: PipelineInput,
    stages: StageResult[],
  ): Promise<Partial<Record<DocumentSlot, OcrDocumentRead>>> {
    const started = Date.now();

    const trabajo = Promise.all(
      SLOTS.map((slot) => this.readText(input, slot, stages)),
    ).then((lecturas) => {
      const reads: Partial<Record<DocumentSlot, OcrDocumentRead>> = {};
      lecturas.forEach((read, index) => {
        if (read) reads[SLOTS[index]] = read;
      });
      return reads;
    });

    const presupuesto = input.ocrBudgetMs ?? OCR_BUDGET_MS;

    return withTimeout(trabajo, presupuesto, () => {
      const error = verificationError("STAGE_TIMEOUT", {
        slot: "de lectura del texto impreso",
        ms: presupuesto,
      });
      this.logger.warn(describeError(error));
      stages.push({
        stage: "texto",
        status: "failed",
        durationMs: Date.now() - started,
        error,
        note: "la verificación sigue con el PDF417 y los datos de la cuenta",
      });
      return {};
    });
  }

  private async readText(
    input: PipelineInput,
    slot: DocumentSlot,
    stages: StageResult[],
  ): Promise<OcrDocumentRead | null> {
    const images = input.images[slot];
    if (!images) {
      stages.push({
        stage: `texto:${slot}`,
        status: "skipped",
        durationMs: 0,
        note: "no se recibió esa foto",
      });
      return null;
    }

    const started = Date.now();
    try {
      const { bytes, mimeType } = await images.load(images.ocrVariant);
      const lectura = await this.ocr.read(slot, bytes, mimeType, {
        withBoxes: input.withBoxes,
      });

      stages.push({
        stage: `texto:${slot}`,
        status: lectura.ok ? "ok" : "failed",
        durationMs: Date.now() - started,
        ...(lectura.ok ? {} : { error: lectura.error }),
        ...(lectura.ok && lectura.data.warnings.length > 0
          ? { note: `${lectura.data.warnings.length} advertencias` }
          : {}),
      });

      return lectura.ok ? lectura.data : null;
    } catch (cause) {
      const error = verificationError("IMAGE_DOWNLOAD_FAILED", {
        slot,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      stages.push({
        stage: `texto:${slot}`,
        status: "failed",
        durationMs: Date.now() - started,
        error,
      });
      return null;
    }
  }

  /** El MRZ sale del texto del dorso: depende del OCR, no de los códigos. */
  private parseMrz(
    dniBack: OcrDocumentRead | null | undefined,
    stages: StageResult[],
  ): { data: MrzData | null; error?: VerificationError } {
    const started = Date.now();
    const lineas = dniBack?.mrzLines ?? [];

    if (lineas.length === 0) {
      stages.push({
        stage: "mrz",
        status: "skipped",
        durationMs: 0,
        note: "no se transcribieron las líneas del dorso",
      });
      return { data: null };
    }

    const result = tryParseMrzTd1(lineas);
    stages.push({
      stage: "mrz",
      status: result.ok ? "ok" : "failed",
      durationMs: Date.now() - started,
      ...(result.ok ? {} : { error: result.error }),
      ...(result.ok && result.warnings.length > 0
        ? { note: result.warnings[0].message }
        : {}),
    });

    return result.ok
      ? { data: result.data }
      : { data: null, error: result.error };
  }

  /** Corre una etapa midiéndola, y no la deja tumbar el proceso entero. */
  private async stage<T>(
    stages: StageResult[],
    name: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await work();
      stages.push({
        stage: name,
        status: "ok",
        durationMs: Date.now() - started,
      });
      return result;
    } catch (cause) {
      const error = verificationError(
        "STAGE_CRASHED",
        {
          slot: name,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        cause instanceof Error ? cause.stack?.slice(0, 300) : undefined,
      );
      this.logger.error(describeError(error));
      stages.push({
        stage: name,
        status: "failed",
        durationMs: Date.now() - started,
        error,
      });
      throw cause;
    }
  }
}
