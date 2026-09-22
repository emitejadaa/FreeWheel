import { Logger, ServiceUnavailableException } from "@nestjs/common";
import {
  DocumentAnalysisStatus,
  DocumentVerificationStatus,
  VehicleVerificationStatus,
  VerifiedDocumentType,
} from "@prisma/client";
import { parseCloudinaryUrl } from "../media/cloudinary.service";
import {
  DOCUMENT_BATCH_SIZE,
  RATE_LIMIT_BATCH_SIZE,
  RUN_TIME_BUDGET_MS,
  RetentionService,
} from "./retention.service";

/**
 * El trabajo que borra las fotos de documentos cuando ya no sirven.
 *
 * Lo que cuida este archivo son las dos maneras de equivocarse, que no pesan
 * igual. Borrar DE MENOS es guardar el DNI de alguien más tiempo del que la ley
 * permite. Borrar DE MÁS es peor, porque no tiene vuelta: dejar sin fotos a un
 * documento que un admin todavía tiene que mirar, o poner la URL en null
 * cuando el archivo sigue en Cloudinary, que es quedarse con el documento sin
 * forma de encontrarlo.
 *
 * La base es un doble en memoria que EVALÚA los filtros de Prisma que usa el
 * servicio (y lanza ante cualquier operador que no conoce). Así "MANUAL_REVIEW
 * no se toca" se prueba sobre filas de verdad y no mirando la forma de un
 * objeto `where`, que es lo que un test frágil haría.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-22T12:00:00.000Z");
const CLOUD = "test-cloud";

const daysAgo = (days: number, extraMs = 0) =>
  new Date(NOW.getTime() - days * DAY_MS - extraMs);

// ── Doble de Prisma ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type OrderBy = Record<string, "asc" | "desc">;

interface FindArgs {
  where?: Where;
  select?: Record<string, boolean>;
  orderBy?: OrderBy | OrderBy[];
  take?: number;
}

interface Hooks {
  beforeDeleteMany?: () => void;
}

function toComparable(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "string") return value;
  throw new Error(`El doble no sabe comparar ${String(value)}`);
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  return a === b;
}

/**
 * Un campo contra una condición, con la semántica de SQL para los null:
 * cualquier comparación contra NULL da falso, salvo preguntar si es NULL.
 */
function matchField(raw: unknown, cond: unknown): boolean {
  const value = raw === undefined ? null : raw;
  if (cond === undefined) return true;
  if (cond === null) return value === null;
  if (cond instanceof Date || typeof cond !== "object") {
    return equal(value, cond);
  }

  return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
    if (arg === undefined) return true;
    switch (op) {
      case "not":
        return arg === null
          ? value !== null
          : value !== null && !equal(value, arg);
      case "in":
        return (
          value !== null && (arg as unknown[]).some((v) => equal(value, v))
        );
      case "lt":
        return value !== null && toComparable(value) < toComparable(arg);
      case "lte":
        return value !== null && toComparable(value) <= toComparable(arg);
      case "gt":
        return value !== null && toComparable(value) > toComparable(arg);
      case "gte":
        return value !== null && toComparable(value) >= toComparable(arg);
      default:
        throw new Error(`El doble de Prisma no soporta el operador "${op}"`);
    }
  });
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      return (list as Where[]).every((w) => matches(row, w));
    }
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    if (key === "NOT") {
      throw new Error("El doble de Prisma no soporta NOT");
    }
    return matchField(row[key], cond);
  });
}

function sortRows(rows: Row[], orderBy: OrderBy | OrderBy[] | undefined) {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const entry of keys) {
      const [field, dir] = Object.entries(entry)[0];
      const x = toComparable(a[field]);
      const y = toComparable(b[field]);
      if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

function pick(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key]]),
  );
}

/**
 * Un modelo de Prisma sobre un array. Las lecturas devuelven COPIAS: si
 * devolvieran la misma referencia, un cambio concurrente sobre la fila se
 * "vería" en lo que el servicio ya leyó, y el test de concurrencia no probaría
 * nada. `updateMany` imita a @updatedAt.
 */
function fakeModel(rows: Row[], hooks: Hooks) {
  return {
    count: jest.fn(({ where }: { where?: Where } = {}) =>
      Promise.resolve(rows.filter((row) => matches(row, where)).length),
    ),
    findMany: jest.fn((args: FindArgs = {}) => {
      const found = sortRows(
        rows.filter((row) => matches(row, args.where)),
        args.orderBy,
      ).slice(0, args.take ?? Infinity);
      return Promise.resolve(found.map((row) => pick(row, args.select)));
    }),
    updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) {
        Object.assign(row, { updatedAt: new Date(NOW.getTime()) }, data);
      }
      return Promise.resolve({ count: found.length });
    }),
    deleteMany: jest.fn(({ where }: { where: Where }) => {
      hooks.beforeDeleteMany?.();
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    }),
  };
}

// ── Filas de prueba ────────────────────────────────────────────────────────

let seq = 0;

const imageUrl = (path: string, cloud = CLOUD) =>
  `https://res.cloudinary.com/${cloud}/image/authenticated/${path}.jpg`;

function identityDoc(overrides: Row = {}): Row {
  seq += 1;
  const userId = (overrides.userId as string) ?? `user-${seq}`;
  return {
    id: `doc-${seq}`,
    userId,
    type: VerifiedDocumentType.DNI,
    status: DocumentVerificationStatus.APPROVED,
    frontUrl: imageUrl(`identity/${userId}/dni_front_1700000000_abcdef01`),
    backUrl: imageUrl(`identity/${userId}/dni_back_1700000000_abcdef01`),
    documentNumber: "30123456",
    declared: { expiresAt: "2039-04-06" },
    analysisStatus: DocumentAnalysisStatus.DONE,
    analysisRequestedAt: daysAgo(400),
    reviewedAt: daysAgo(31),
    photosPurgedAt: null,
    createdAt: daysAgo(400),
    updatedAt: daysAgo(31),
    ...overrides,
  };
}

function vehicleVerification(overrides: Row = {}): Row {
  seq += 1;
  const ownerId = (overrides.ownerId as string) ?? `owner-${seq}`;
  return {
    id: `vver-${seq}`,
    vehicleId: `vehicle-${seq}`,
    ownerId,
    status: VehicleVerificationStatus.APPROVED,
    cedulaFrontUrl: imageUrl(`vehicle/${ownerId}/cedula_front_${seq}`),
    cedulaBackUrl: imageUrl(`vehicle/${ownerId}/cedula_back_${seq}`),
    plate: "AB123CD",
    holderName: "Juana Pérez",
    reviewedAt: daysAgo(181),
    photosPurgedAt: null,
    createdAt: daysAgo(400),
    updatedAt: daysAgo(181),
    ...overrides,
  };
}

function bucket(overrides: Row = {}): Row {
  seq += 1;
  return {
    key: `auth.login:ip:10.0.${Math.floor(seq / 250)}.${seq % 250}`,
    count: 3,
    windowStartedAt: daysAgo(3),
    blockedUntil: null,
    updatedAt: daysAgo(3),
    ...overrides,
  };
}

// ── Armado ─────────────────────────────────────────────────────────────────

interface AuditEntry {
  actorId?: string;
  targetUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: unknown;
}

function crear(
  opts: {
    env?: Record<string, string>;
    docs?: Row[];
    vehicles?: Row[];
    buckets?: Row[];
    cloudinaryConfigured?: boolean;
  } = {},
) {
  const store = {
    // Copias: las filas que arma cada test quedan como la foto del "antes",
    // y la base del doble es la única que cambia.
    documentVerification: (opts.docs ?? []).map((row) => ({ ...row })),
    vehicleVerification: (opts.vehicles ?? []).map((row) => ({ ...row })),
    rateLimitBucket: (opts.buckets ?? []).map((row) => ({ ...row })),
  };
  const hooks: Hooks = {};
  const prisma = {
    documentVerification: fakeModel(store.documentVerification, hooks),
    vehicleVerification: fakeModel(store.vehicleVerification, hooks),
    rateLimitBucket: fakeModel(store.rateLimitBucket, hooks),
  };

  const getCloudName = jest.fn(() => {
    if (opts.cloudinaryConfigured === false) {
      throw new ServiceUnavailableException(
        "Cloudinary no esta configurado en el servidor",
      );
    }
    return CLOUD;
  });
  const destroyed: string[] = [];
  const cloudinary = {
    getCloudName,
    // El parser REAL: es la parte que decide qué archivo se borra.
    parseAssetUrl: jest.fn((url: string) =>
      parseCloudinaryUrl(getCloudName(), url),
    ),
    destroyByUrl: jest.fn((url: string) => {
      destroyed.push(url);
      return Promise.resolve(true);
    }),
  };

  const audits: AuditEntry[] = [];
  const auditLog = {
    create: jest.fn((entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve({});
    }),
  };
  const config = { get: (key: string) => opts.env?.[key] };

  const service = new RetentionService(
    prisma as never,
    cloudinary as never,
    auditLog as never,
    config as never,
  );
  return {
    service,
    store,
    prisma,
    cloudinary,
    auditLog,
    destroyed,
    audits,
    hooks,
  };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  warn = jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);
  error = jest
    .spyOn(Logger.prototype, "error")
    .mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const messages = (spy: jest.SpyInstance) =>
  spy.mock.calls.map((call: unknown[]) => String(call[0]));

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RetentionService.purgeExpired", () => {
  describe("documentos de identidad aprobados", () => {
    it("borra las dos fotos y deja la fila como constancia", async () => {
      const doc = identityDoc();
      const { service, store, destroyed } = crear({ docs: [doc] });
      const antes = { ...doc };

      const result = await service.purgeExpired(NOW);

      expect(destroyed).toEqual([antes.frontUrl, antes.backUrl]);
      const fila = store.documentVerification[0];
      expect(fila).toMatchObject({
        frontUrl: null,
        backUrl: null,
        photosPurgedAt: NOW,
        // Lo que prueba que la verificación se hizo sigue ahí.
        status: DocumentVerificationStatus.APPROVED,
        documentNumber: "30123456",
        declared: { expiresAt: "2039-04-06" },
        reviewedAt: antes.reviewedAt,
      });
      expect(result.identityDocumentsPurged).toBe(1);
      expect(result.categories.identityApproved).toEqual({
        purged: 1,
        failed: 0,
        skipped: 0,
        deferred: 0,
      });
    });

    it("cuenta el plazo desde la revisión, al milisegundo", async () => {
      // Justo en el corte todavía no venció: el borrado es irreversible, así
      // que el empate se resuelve guardando.
      const justo = identityDoc({
        reviewedAt: daysAgo(30),
        updatedAt: daysAgo(30),
      });
      const pasado = identityDoc({
        reviewedAt: daysAgo(30, 1),
        updatedAt: daysAgo(30, 1),
      });
      const { service, store } = crear({ docs: [justo, pasado] });

      await service.purgeExpired(NOW);

      const [a, b] = store.documentVerification;
      expect(a.frontUrl).not.toBeNull();
      expect(a.photosPurgedAt).toBeNull();
      expect(b.frontUrl).toBeNull();
      expect(b.photosPurgedAt).toEqual(NOW);
    });

    it("sin fecha de revisión cuenta desde updatedAt", async () => {
      const viejo = identityDoc({ reviewedAt: null, updatedAt: daysAgo(31) });
      const nuevo = identityDoc({ reviewedAt: null, updatedAt: daysAgo(29) });
      const { service, store } = crear({ docs: [viejo, nuevo] });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityApproved.purged).toBe(1);
      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(store.documentVerification[1].frontUrl).not.toBeNull();
    });

    it("una edición posterior a la revisión no reinicia el plazo", async () => {
      // Un admin que corrige una nota toca updatedAt, pero la foto se miró
      // cuando se miró.
      const doc = identityDoc({
        reviewedAt: daysAgo(31),
        updatedAt: daysAgo(2),
      });
      const { service, store } = crear({ docs: [doc] });

      await service.purgeExpired(NOW);

      expect(store.documentVerification[0].frontUrl).toBeNull();
    });

    it("respeta IDENTITY_PHOTO_RETENTION_DAYS", async () => {
      const ocho = identityDoc({ reviewedAt: daysAgo(8) });
      const seis = identityDoc({ reviewedAt: daysAgo(6) });
      const { service, store } = crear({
        env: { IDENTITY_PHOTO_RETENTION_DAYS: "7" },
        docs: [ocho, seis],
      });

      await service.purgeExpired(NOW);

      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(store.documentVerification[1].frontUrl).not.toBeNull();
    });

    it.each(["0", "-5", "abc", "0.5"])(
      "un plazo inválido (%s) no adelanta el borrado: usa 30 días y avisa",
      async (valor) => {
        const doc = identityDoc({ reviewedAt: daysAgo(8) });
        const { service, store, destroyed } = crear({
          env: { IDENTITY_PHOTO_RETENTION_DAYS: valor },
          docs: [doc],
        });

        await service.purgeExpired(NOW);

        expect(destroyed).toEqual([]);
        expect(store.documentVerification[0].frontUrl).not.toBeNull();
        expect(messages(warn).join("\n")).toContain(
          "IDENTITY_PHOTO_RETENTION_DAYS",
        );
      },
    );

    it("una variable vacía usa el plazo por omisión sin quejarse", async () => {
      const { service } = crear({
        env: { IDENTITY_PHOTO_RETENTION_DAYS: "  " },
      });

      await service.purgeExpired(NOW);

      expect(messages(warn).join("\n")).not.toContain(
        "IDENTITY_PHOTO_RETENTION_DAYS",
      );
    });

    it("audita cada purga sin guardar datos personales", async () => {
      const doc = identityDoc({ id: "doc-a", userId: "user-a" });
      const { service, audits } = crear({ docs: [doc] });

      await service.purgeExpired(NOW);

      expect(audits).toEqual([
        {
          targetUserId: "user-a",
          action: "retention.identity_photos_purged",
          entityType: "DocumentVerification",
          entityId: "doc-a",
          metadata: {
            reason: "approved",
            documentType: VerifiedDocumentType.DNI,
            status: DocumentVerificationStatus.APPROVED,
            retentionDays: 30,
            filesDeleted: 2,
          },
        },
      ]);
      const texto = JSON.stringify(audits);
      expect(texto).not.toContain("cloudinary");
      expect(texto).not.toContain("30123456");
      expect(texto).not.toContain("2039");
    });

    it("vuelve a purgar un documento reenviado después de una purga", async () => {
      // Reenviar pisa las URLs pero no limpia photosPurgedAt. Si el trabajo
      // filtrara por esa marca, estas fotos nuevas no se borrarían nunca.
      const doc = identityDoc({ photosPurgedAt: daysAgo(90) });
      const { service, store } = crear({ docs: [doc] });

      const result = await service.purgeExpired(NOW);

      expect(result.identityDocumentsPurged).toBe(1);
      expect(store.documentVerification[0]).toMatchObject({
        frontUrl: null,
        backUrl: null,
        photosPurgedAt: NOW,
      });
    });

    it("no toca un aprobado reciente", async () => {
      const doc = identityDoc({
        reviewedAt: daysAgo(5),
        updatedAt: daysAgo(5),
      });
      const { service, destroyed, audits } = crear({ docs: [doc] });

      const result = await service.purgeExpired(NOW);

      expect(result.identityDocumentsPurged).toBe(0);
      expect(destroyed).toEqual([]);
      expect(audits).toEqual([]);
    });
  });

  describe("documentos abandonados", () => {
    const abandonado = (overrides: Row = {}) =>
      identityDoc({
        status: DocumentVerificationStatus.FAILED,
        reviewedAt: null,
        updatedAt: daysAgo(91),
        ...overrides,
      });

    it("purga PENDING y FAILED sin movimiento en 90 días", async () => {
      const failed = abandonado();
      const pending = abandonado({
        status: DocumentVerificationStatus.PENDING,
        analysisStatus: DocumentAnalysisStatus.FAILED,
      });
      const reciente = abandonado({ updatedAt: daysAgo(89) });
      const { service, store, audits } = crear({
        docs: [failed, pending, reciente],
      });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityAbandoned.purged).toBe(2);
      const [a, b, c] = store.documentVerification;
      expect(a).toMatchObject({ frontUrl: null, photosPurgedAt: NOW });
      expect(b).toMatchObject({ frontUrl: null, photosPurgedAt: NOW });
      expect(c.frontUrl).not.toBeNull();
      // La fila queda con su estado: es la constancia de que se intentó.
      expect(a.status).toBe(DocumentVerificationStatus.FAILED);
      expect(b.status).toBe(DocumentVerificationStatus.PENDING);
      expect(audits.map((x) => (x.metadata as Row).reason)).toEqual([
        "abandoned",
        "abandoned",
      ]);
    });

    it("MANUAL_REVIEW no se toca por viejo que sea", async () => {
      const doc = abandonado({
        status: DocumentVerificationStatus.MANUAL_REVIEW,
        updatedAt: daysAgo(1000),
        reviewRequestedAt: daysAgo(1000),
      });
      const { service, store, destroyed } = crear({ docs: [doc] });
      const antes = { ...doc };

      const result = await service.purgeExpired(NOW);

      expect(destroyed).toEqual([]);
      expect(store.documentVerification[0]).toEqual(antes);
      expect(result.identityDocumentsPurged).toBe(0);
    });

    it("un análisis en curso conserva sus fotos aunque la fila sea vieja", async () => {
      const doc = abandonado({
        status: DocumentVerificationStatus.PENDING,
        analysisStatus: DocumentAnalysisStatus.QUEUED,
        analysisRequestedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
      const { service, store, destroyed } = crear({ docs: [doc] });
      const antes = { ...doc };

      await service.purgeExpired(NOW);

      expect(destroyed).toEqual([]);
      expect(store.documentVerification[0]).toEqual(antes);
    });

    it("un QUEUED sin fecha de pedido también se respeta", async () => {
      const doc = abandonado({
        status: DocumentVerificationStatus.PENDING,
        analysisStatus: DocumentAnalysisStatus.QUEUED,
        analysisRequestedAt: null,
      });
      const { service, destroyed } = crear({ docs: [doc] });

      await service.purgeExpired(NOW);

      expect(destroyed).toEqual([]);
    });

    it("un análisis cuyo aviso nunca volvió no retiene las fotos para siempre", async () => {
      const doc = abandonado({
        status: DocumentVerificationStatus.PENDING,
        analysisStatus: DocumentAnalysisStatus.QUEUED,
        analysisRequestedAt: daysAgo(91),
      });
      const { service, store } = crear({ docs: [doc] });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityAbandoned.purged).toBe(1);
      expect(store.documentVerification[0].frontUrl).toBeNull();
    });

    it("respeta ABANDONED_DOCUMENT_RETENTION_DAYS", async () => {
      const once = abandonado({ updatedAt: daysAgo(11) });
      const nueve = abandonado({ updatedAt: daysAgo(9) });
      const { service, store } = crear({
        env: { ABANDONED_DOCUMENT_RETENTION_DAYS: "10" },
        docs: [once, nueve],
      });

      await service.purgeExpired(NOW);

      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(store.documentVerification[1].frontUrl).not.toBeNull();
    });

    it("purga la foto que quedó aunque la otra ya no esté", async () => {
      const doc = abandonado({ backUrl: null });
      const { service, destroyed, audits } = crear({ docs: [doc] });

      await service.purgeExpired(NOW);

      expect(destroyed).toEqual([doc.frontUrl]);
      expect((audits[0].metadata as Row).filesDeleted).toBe(1);
    });
  });

  describe("documentos rechazados que conservan fotos", () => {
    it("se purgan sin esperar ningún plazo", async () => {
      const doc = identityDoc({
        status: DocumentVerificationStatus.REJECTED,
        reviewedAt: new Date(NOW.getTime() - 60_000),
        updatedAt: new Date(NOW.getTime() - 60_000),
      });
      const { service, store, audits } = crear({ docs: [doc] });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityRejected.purged).toBe(1);
      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(audits[0].metadata).toMatchObject({
        reason: "rejected",
        retentionDays: null,
      });
    });

    it("un rechazado sin fotos no cuenta para nada", async () => {
      const doc = identityDoc({
        status: DocumentVerificationStatus.REJECTED,
        frontUrl: null,
        backUrl: null,
      });
      const { service, destroyed, prisma } = crear({ docs: [doc] });

      const result = await service.purgeExpired(NOW);

      expect(result.identityDocumentsPurged).toBe(0);
      expect(destroyed).toEqual([]);
      expect(prisma.documentVerification.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("cédulas de vehículos", () => {
    it("purga las aprobadas hace más de 180 días y deja la fila", async () => {
      const vieja = vehicleVerification();
      const nueva = vehicleVerification({
        reviewedAt: daysAgo(179),
        updatedAt: daysAgo(179),
      });
      const { service, store, destroyed } = crear({
        vehicles: [vieja, nueva],
      });

      const result = await service.purgeExpired(NOW);

      expect(result.vehicleDocumentsPurged).toBe(1);
      expect(destroyed).toEqual([vieja.cedulaFrontUrl, vieja.cedulaBackUrl]);
      const [a, b] = store.vehicleVerification;
      expect(a).toMatchObject({
        cedulaFrontUrl: null,
        cedulaBackUrl: null,
        photosPurgedAt: NOW,
        status: VehicleVerificationStatus.APPROVED,
        plate: "AB123CD",
      });
      expect(b.cedulaFrontUrl).not.toBeNull();
    });

    it("sin fecha de revisión cuenta desde updatedAt", async () => {
      const v = vehicleVerification({ reviewedAt: null });
      const { service, store } = crear({ vehicles: [v] });

      await service.purgeExpired(NOW);

      expect(store.vehicleVerification[0].cedulaFrontUrl).toBeNull();
    });

    it("respeta VEHICLE_DOCUMENT_RETENTION_DAYS", async () => {
      const v = vehicleVerification({
        reviewedAt: daysAgo(181),
        updatedAt: daysAgo(181),
      });
      const { service, store } = crear({
        env: { VEHICLE_DOCUMENT_RETENTION_DAYS: "365" },
        vehicles: [v],
      });

      await service.purgeExpired(NOW);

      expect(store.vehicleVerification[0].cedulaFrontUrl).not.toBeNull();
    });

    it("una verificación PENDING no se toca por vieja que sea", async () => {
      const v = vehicleVerification({
        status: VehicleVerificationStatus.PENDING,
        reviewedAt: null,
        updatedAt: daysAgo(1000),
      });
      const { service, destroyed } = crear({ vehicles: [v] });

      await service.purgeExpired(NOW);

      expect(destroyed).toEqual([]);
    });

    it("las rechazadas con fotos se purgan a cualquier edad", async () => {
      const conFotos = vehicleVerification({
        status: VehicleVerificationStatus.REJECTED,
        reviewedAt: new Date(NOW.getTime() - 60_000),
        updatedAt: new Date(NOW.getTime() - 60_000),
        cedulaBackUrl: null,
      });
      const sinFotos = vehicleVerification({
        status: VehicleVerificationStatus.REJECTED,
        cedulaFrontUrl: null,
        cedulaBackUrl: null,
      });
      const { service, store, destroyed } = crear({
        vehicles: [conFotos, sinFotos],
      });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.vehicleRejected.purged).toBe(1);
      expect(destroyed).toEqual([conFotos.cedulaFrontUrl]);
      expect(store.vehicleVerification[0].photosPurgedAt).toEqual(NOW);
      expect(store.vehicleVerification[1].photosPurgedAt).toBeNull();
    });

    it("audita con el dueño como destinatario y sin la patente ni el titular", async () => {
      const v = vehicleVerification({
        id: "vver-a",
        ownerId: "owner-a",
        vehicleId: "vehicle-a",
      });
      const { service, audits } = crear({ vehicles: [v] });

      await service.purgeExpired(NOW);

      expect(audits).toEqual([
        {
          targetUserId: "owner-a",
          action: "retention.vehicle_photos_purged",
          entityType: "VehicleVerification",
          entityId: "vver-a",
          metadata: {
            reason: "approved",
            vehicleId: "vehicle-a",
            status: VehicleVerificationStatus.APPROVED,
            retentionDays: 180,
            filesDeleted: 2,
          },
        },
      ]);
      const texto = JSON.stringify(audits);
      expect(texto).not.toContain("AB123CD");
      expect(texto).not.toContain("Juana");
      expect(texto).not.toContain("cloudinary");
    });
  });

  describe("cuando Cloudinary falla", () => {
    it("la fila que falla queda intacta y el resto del lote sigue", async () => {
      const a = identityDoc({ updatedAt: daysAgo(33) });
      const b = identityDoc({ id: "doc-falla", updatedAt: daysAgo(32) });
      const c = identityDoc({ updatedAt: daysAgo(31) });
      const { service, store, cloudinary, audits } = crear({
        docs: [a, b, c],
      });
      const antesDeB = { ...b };
      cloudinary.destroyByUrl.mockImplementation((url: string) =>
        url === b.backUrl
          ? Promise.reject(
              new ServiceUnavailableException(
                "Cloudinary destroy respondió 500",
              ),
            )
          : Promise.resolve(true),
      );

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityApproved).toEqual({
        purged: 2,
        failed: 1,
        skipped: 0,
        deferred: 0,
      });
      expect(result.identityDocumentsFailed).toBe(1);
      expect(store.documentVerification[1]).toEqual(antesDeB);
      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(store.documentVerification[2].frontUrl).toBeNull();
      expect(audits.map((x) => x.entityId)).not.toContain("doc-falla");

      const errores = messages(error).join("\n");
      expect(errores).toContain("doc-falla");
      expect(errores).toContain("Cloudinary destroy respondió 500");
      // El log no lleva el puntero al documento.
      expect(errores).not.toContain("res.cloudinary.com");
    });

    it("la corrida siguiente termina lo que quedó a medias", async () => {
      const doc = identityDoc();
      const { service, store, cloudinary } = crear({ docs: [doc] });
      // Cloudinary de verdad: lo que ya se borró no lo encuentra y contesta
      // false. El dorso falla una sola vez.
      const enCloudinary = new Set([doc.frontUrl, doc.backUrl]);
      let dorsoFalla = true;
      cloudinary.destroyByUrl.mockImplementation((url: string) => {
        if (url === doc.backUrl && dorsoFalla) {
          dorsoFalla = false;
          return Promise.reject(new Error("timeout"));
        }
        return Promise.resolve(enCloudinary.delete(url));
      });

      const primera = await service.purgeExpired(NOW);
      expect(primera.identityDocumentsFailed).toBe(1);
      expect(store.documentVerification[0].frontUrl).toBe(doc.frontUrl);

      const segunda = await service.purgeExpired(NOW);
      // El frente ya no estaba (false) y eso no es un fallo.
      expect(await cloudinary.destroyByUrl.mock.results[2].value).toBe(false);
      expect(segunda.identityDocumentsPurged).toBe(1);
      expect(segunda.identityDocumentsFailed).toBe(0);
      expect(enCloudinary.size).toBe(0);
      expect(store.documentVerification[0]).toMatchObject({
        frontUrl: null,
        backUrl: null,
        photosPurgedAt: NOW,
      });
    });

    it("una URL de otra cuenta no se borra ni se descarta", async () => {
      const doc = identityDoc({
        frontUrl: imageUrl("identity/u/dni_front_1_abcdef01", "otra-cuenta"),
      });
      const { service, store, cloudinary } = crear({ docs: [doc] });
      const antes = { ...doc };

      const result = await service.purgeExpired(NOW);

      // Ni siquiera la otra cara: la fila no puede quedar a medio purgar.
      expect(cloudinary.destroyByUrl).not.toHaveBeenCalled();
      expect(store.documentVerification[0]).toEqual(antes);
      expect(result.categories.identityApproved.failed).toBe(1);
    });

    it("un archivo que no es imagen no se da por borrado", async () => {
      // destroy() solo habla con el endpoint de imágenes: para un `raw`
      // contestaría "no lo encuentro" y se perdería el puntero.
      const v = vehicleVerification({
        cedulaFrontUrl: `https://res.cloudinary.com/${CLOUD}/raw/upload/vehicle/cedula.pdf`,
      });
      const { service, store, cloudinary } = crear({ vehicles: [v] });

      const result = await service.purgeExpired(NOW);

      expect(cloudinary.destroyByUrl).not.toHaveBeenCalled();
      expect(store.vehicleVerification[0].cedulaFrontUrl).toBe(
        v.cedulaFrontUrl,
      );
      expect(result.vehicleDocumentsFailed).toBe(1);
    });

    it("sin Cloudinary configurado no toca ninguna foto y lo dice una vez", async () => {
      const docs = [identityDoc(), identityDoc()];
      const viejo = bucket();
      const { service, store, cloudinary } = crear({
        docs,
        buckets: [viejo],
        vehicles: [vehicleVerification()],
        cloudinaryConfigured: false,
      });

      const result = await service.purgeExpired(NOW);

      expect(result.storageUnavailable).toBe(true);
      expect(cloudinary.destroyByUrl).not.toHaveBeenCalled();
      expect(store.documentVerification.every((d) => d.frontUrl)).toBe(true);
      expect(result.categories.identityApproved.deferred).toBe(2);
      expect(result.categories.vehicleApproved.deferred).toBe(1);
      expect(result.deferred).toBe(3);
      expect(error).not.toHaveBeenCalled();
      // Los contadores no dependen de Cloudinary.
      expect(result.rateLimitBucketsDeleted).toBe(1);
    });

    it("si falla la auditoría, la purga cuenta igual y no se reintenta", async () => {
      const doc = identityDoc();
      const { service, store, prisma, auditLog } = crear({ docs: [doc] });
      auditLog.create.mockRejectedValue(new Error("FK violada"));

      const result = await service.purgeExpired(NOW);

      expect(result.identityDocumentsPurged).toBe(1);
      expect(result.identityDocumentsFailed).toBe(0);
      expect(store.documentVerification[0].photosPurgedAt).toEqual(NOW);
      expect(prisma.documentVerification.updateMany).toHaveBeenCalledTimes(1);
      expect(messages(error).join("\n")).toContain("auditoría");
    });
  });

  describe("lotes acotados", () => {
    it("procesa hasta el tope por categoría, lo más viejo primero, y avisa cuánto queda", async () => {
      const total = DOCUMENT_BATCH_SIZE + 5;
      const docs = Array.from({ length: total }, (_, i) =>
        identityDoc({
          id: `doc-${String(i).padStart(3, "0")}`,
          reviewedAt: daysAgo(31 + i),
          updatedAt: daysAgo(31 + i),
        }),
      );
      const { service, store } = crear({ docs });

      const primera = await service.purgeExpired(NOW);

      expect(primera.categories.identityApproved).toMatchObject({
        purged: DOCUMENT_BATCH_SIZE,
        deferred: 5,
      });
      expect(primera.deferred).toBe(5);
      // Los que esperan son los cinco más nuevos.
      const pendientes = store.documentVerification
        .filter((d) => d.frontUrl !== null)
        .map((d) => d.id);
      expect(pendientes).toEqual([
        "doc-000",
        "doc-001",
        "doc-002",
        "doc-003",
        "doc-004",
      ]);
      expect(messages(warn).join("\n")).toMatch(/quedan 5 para la próxima/);

      const segunda = await service.purgeExpired(NOW);
      expect(segunda.categories.identityApproved).toMatchObject({
        purged: 5,
        deferred: 0,
      });
    });

    it("cuando se acaba el tiempo deja de empezar documentos y los cuenta", async () => {
      let reloj = 1_000_000;
      jest.spyOn(Date, "now").mockImplementation(() => reloj);
      const docs = [identityDoc(), identityDoc(), identityDoc()];
      const vehicles = [
        vehicleVerification({ status: VehicleVerificationStatus.REJECTED }),
      ];
      const { service, store, cloudinary } = crear({
        docs,
        vehicles,
        buckets: [bucket()],
      });
      // El primer documento se come todo el tiempo de la corrida.
      cloudinary.destroyByUrl.mockImplementation(() => {
        reloj += RUN_TIME_BUDGET_MS;
        return Promise.resolve(true);
      });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityApproved).toMatchObject({
        purged: 1,
        deferred: 2,
      });
      expect(result.categories.vehicleRejected).toMatchObject({
        purged: 0,
        deferred: 1,
      });
      expect(store.vehicleVerification[0].cedulaFrontUrl).not.toBeNull();
      expect(result.deferred).toBe(3);
      // Los contadores son un DELETE solo, sin llamadas afuera: se hacen igual.
      expect(result.rateLimitBucketsDeleted).toBe(1);
    });
  });

  describe("idempotencia", () => {
    it("una segunda corrida no borra, no escribe y no audita nada", async () => {
      const { service, destroyed, audits, prisma } = crear({
        docs: [
          identityDoc(),
          identityDoc({
            status: DocumentVerificationStatus.FAILED,
            updatedAt: daysAgo(91),
          }),
        ],
        vehicles: [
          vehicleVerification(),
          vehicleVerification({ status: VehicleVerificationStatus.REJECTED }),
        ],
        buckets: [bucket()],
      });

      const primera = await service.purgeExpired(NOW);
      expect(primera.identityDocumentsPurged).toBe(2);
      expect(primera.vehicleDocumentsPurged).toBe(2);
      const borradosAntes = destroyed.length;
      const auditadosAntes = audits.length;
      prisma.documentVerification.updateMany.mockClear();
      prisma.vehicleVerification.updateMany.mockClear();

      const segunda = await service.purgeExpired(NOW);

      expect(segunda).toMatchObject({
        identityDocumentsPurged: 0,
        vehicleDocumentsPurged: 0,
        rateLimitBucketsDeleted: 0,
        identityDocumentsFailed: 0,
        vehicleDocumentsFailed: 0,
        deferred: 0,
      });
      expect(destroyed).toHaveLength(borradosAntes);
      expect(audits).toHaveLength(auditadosAntes);
      expect(prisma.documentVerification.updateMany).not.toHaveBeenCalled();
      expect(prisma.vehicleVerification.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("cambios durante la corrida", () => {
    it("si la persona reenvía mientras se purga, sus fotos nuevas quedan", async () => {
      const doc = identityDoc({
        status: DocumentVerificationStatus.FAILED,
        reviewedAt: null,
        updatedAt: daysAgo(91),
      });
      const { service, store, cloudinary, audits } = crear({ docs: [doc] });
      const nuevas = {
        status: DocumentVerificationStatus.PENDING,
        frontUrl: imageUrl("identity/u/dni_front_nueva"),
        backUrl: imageUrl("identity/u/dni_back_nueva"),
        updatedAt: new Date(NOW.getTime() + 1000),
      };
      cloudinary.destroyByUrl.mockImplementationOnce(() => {
        Object.assign(store.documentVerification[0], nuevas);
        return Promise.resolve(true);
      });

      const result = await service.purgeExpired(NOW);

      expect(result.categories.identityAbandoned).toMatchObject({
        purged: 0,
        skipped: 1,
      });
      expect(store.documentVerification[0]).toMatchObject({
        ...nuevas,
        photosPurgedAt: null,
      });
      expect(audits).toEqual([]);
    });
  });

  describe("contadores del limitador", () => {
    it("borra los quietos hace dos días salvo los que tienen un bloqueo vigente", async () => {
      const quieto = bucket({ key: "quieto" });
      const bloqueoVencido = bucket({
        key: "bloqueo-vencido",
        blockedUntil: daysAgo(1),
      });
      const bloqueado = bucket({
        key: "bloqueado",
        blockedUntil: new Date(NOW.getTime() + DAY_MS),
      });
      const justo = bucket({ key: "justo", updatedAt: daysAgo(2) });
      const activo = bucket({ key: "activo", updatedAt: daysAgo(1) });
      const { service, store } = crear({
        buckets: [quieto, bloqueoVencido, bloqueado, justo, activo],
      });

      const result = await service.purgeExpired(NOW);

      expect(result.rateLimitBucketsDeleted).toBe(2);
      expect(store.rateLimitBucket.map((b) => b.key)).toEqual([
        "bloqueado",
        "justo",
        "activo",
      ]);
    });

    it("un contador que recibió un pedido mientras tanto se queda", async () => {
      const a = bucket({ key: "a" });
      const b = bucket({ key: "b" });
      const { service, store, hooks } = crear({ buckets: [a, b] });
      hooks.beforeDeleteMany = () => {
        const fila = store.rateLimitBucket.find((x) => x.key === "b");
        if (fila) fila.updatedAt = NOW;
      };

      const result = await service.purgeExpired(NOW);

      expect(result.rateLimitBucketsDeleted).toBe(1);
      expect(store.rateLimitBucket.map((x) => x.key)).toEqual(["b"]);
    });

    it("también van por lotes, y avisa cuántos quedan", async () => {
      const buckets = Array.from({ length: RATE_LIMIT_BATCH_SIZE + 3 }, () =>
        bucket(),
      );
      const { service, store } = crear({ buckets });

      const result = await service.purgeExpired(NOW);

      expect(result.rateLimitBucketsDeleted).toBe(RATE_LIMIT_BATCH_SIZE);
      expect(result.categories.rateLimitBuckets.deferred).toBe(3);
      expect(store.rateLimitBucket).toHaveLength(3);
      expect(messages(warn).join("\n")).toMatch(
        /Contadores del limitador: quedan 3/,
      );
    });
  });

  describe("una categoría que no se puede consultar", () => {
    it("no frena a las demás", async () => {
      const { service, store, prisma } = crear({
        docs: [identityDoc()],
        buckets: [bucket()],
      });
      prisma.vehicleVerification.count.mockRejectedValue(
        new Error('relation "VehicleVerification" does not exist'),
      );

      const result = await service.purgeExpired(NOW);

      expect(result.categoriesWithErrors).toEqual([
        "vehicleApproved",
        "vehicleRejected",
      ]);
      expect(result.identityDocumentsPurged).toBe(1);
      expect(result.rateLimitBucketsDeleted).toBe(1);
      expect(store.documentVerification[0].frontUrl).toBeNull();
      expect(messages(error).join("\n")).toContain("VehicleVerification");
    });
  });
});
