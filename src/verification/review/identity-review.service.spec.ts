import { ConfigService } from "@nestjs/config";
import { User, UserVerification, VerificationStatus } from "@prisma/client";
import { AuditLogService } from "../../common/services/audit-log.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  buildVerificationChecklist,
  hasCompleteDocuments,
  IdentityReviewService,
} from "./identity-review.service";
import { AutoApproveReviewer } from "./auto-approve.reviewer";
import { ManualReviewer } from "./manual.reviewer";
import type {
  IdentityReviewer,
  IdentityReviewVerdict,
} from "./identity-reviewer.interface";

type MockPrisma = {
  user: { findUnique: jest.Mock; update: jest.Mock };
  userVerification: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
};

/** Primer argumento de la primera llamada, sin pasar por `any`. */
function firstCallArg(mock: jest.Mock): Record<string, unknown> {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][0] as Record<string, unknown>;
}

function makePrisma(
  clashingSubmission: { id: string } | null = null,
): MockPrisma {
  const prisma: MockPrisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    userVerification: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    // Soporta las dos formas de uso: array de operaciones e interactiva.
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => unknown)({
            user: { update: jest.fn() },
            userVerification: {
              update: jest.fn(),
              findFirst: jest.fn().mockResolvedValue(clashingSubmission),
            },
          })
        : Promise.all(arg as unknown[]),
    ),
  };
  return prisma;
}

interface AuditSpy {
  service: AuditLogService;
  create: jest.Mock;
}

function auditLog(): AuditSpy {
  const create = jest.fn().mockResolvedValue({});
  return { service: { create } as unknown as AuditLogService, create };
}

const config = () => ({ get: () => undefined }) as unknown as ConfigService;

function makeService(
  prisma: MockPrisma,
  reviewer: IdentityReviewer,
  audit = auditLog(),
): IdentityReviewService {
  return new IdentityReviewService(
    prisma as unknown as PrismaService,
    reviewer,
    audit.service,
    config(),
  );
}

/** Reviewer de prueba con veredicto fijo. */
function fixedReviewer(verdict: IdentityReviewVerdict): IdentityReviewer {
  return { name: "test", review: () => Promise.resolve(verdict) };
}

const submission = {
  id: "ver-1",
  userId: "user-1",
  status: VerificationStatus.ID_SUBMITTED,
  dniFrontUrl: "a",
  dniBackUrl: "b",
  licenseFrontUrl: "c",
  licenseBackUrl: "d",
} as unknown as UserVerification;

const fullyReadyUser = {
  id: "user-1",
  firstName: "Juan",
  lastName: "Perez",
  verificationStatus: VerificationStatus.PHONE_VERIFIED,
  emailVerifiedAt: new Date(),
  phoneVerifiedAt: new Date(),
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  dni: "12345678",
  cuil: "20123456786",
  address: "Av. Siempre Viva 742, CABA",
} as unknown as User;

describe("hasCompleteDocuments", () => {
  it("is true only when all four documents are present", () => {
    expect(hasCompleteDocuments(submission)).toBe(true);
    expect(hasCompleteDocuments({ ...submission, licenseBackUrl: null })).toBe(
      false,
    );
    expect(hasCompleteDocuments(null)).toBe(false);
  });
});

describe("buildVerificationChecklist", () => {
  it("derives each item from independent fields", () => {
    expect(buildVerificationChecklist(fullyReadyUser, submission)).toEqual({
      emailVerified: true,
      phoneVerified: true,
      documentsSubmitted: true,
      dateOfBirthProvided: true,
      identityDataProvided: true,
    });
  });

  it("requires dni, cuil and address together for identityDataProvided", () => {
    const withoutCuil = { ...fullyReadyUser, cuil: null } as unknown as User;
    expect(
      buildVerificationChecklist(withoutCuil, submission).identityDataProvided,
    ).toBe(false);
  });

  it("does not count a rejected submission as submitted", () => {
    const rejected = { ...submission, status: VerificationStatus.REJECTED };
    expect(
      buildVerificationChecklist(fullyReadyUser, rejected).documentsSubmitted,
    ).toBe(false);
  });
});

describe("IdentityReviewService.evaluate — gating", () => {
  const readyPrisma = () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(fullyReadyUser);
    prisma.userVerification.findFirst.mockResolvedValue(submission);
    return prisma;
  };

  it("does nothing when the phone is not verified", async () => {
    const prisma = readyPrisma();
    prisma.user.findUnique.mockResolvedValue({
      ...fullyReadyUser,
      phoneVerifiedAt: null,
    });

    const service = makeService(prisma, new AutoApproveReviewer());
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does nothing when the manual identity data is incomplete", async () => {
    const prisma = readyPrisma();
    prisma.user.findUnique.mockResolvedValue({
      ...fullyReadyUser,
      address: null,
    });

    const service = makeService(prisma, new AutoApproveReviewer());
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does nothing when the account is already verified", async () => {
    const prisma = readyPrisma();
    prisma.user.findUnique.mockResolvedValue({
      ...fullyReadyUser,
      verificationStatus: VerificationStatus.VERIFIED,
    });

    const service = makeService(prisma, new AutoApproveReviewer());
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.userVerification.findFirst).not.toHaveBeenCalled();
  });

  it("does nothing when documents are incomplete", async () => {
    const prisma = readyPrisma();
    prisma.userVerification.findFirst.mockResolvedValue({
      ...submission,
      licenseBackUrl: null,
    });

    const service = makeService(prisma, new AutoApproveReviewer());
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("IdentityReviewService.evaluate — verdicts", () => {
  const readyPrisma = (clash: { id: string } | null = null) => {
    const prisma = makePrisma(clash);
    prisma.user.findUnique.mockResolvedValue(fullyReadyUser);
    prisma.userVerification.findFirst.mockResolvedValue(submission);
    return prisma;
  };

  it("verifies the account on an approved verdict", async () => {
    const prisma = readyPrisma();
    const audit = auditLog();
    const service = makeService(prisma, new AutoApproveReviewer(), audit);

    expect(await service.evaluate("user-1")).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const auditArg = firstCallArg(audit.create);
    expect(auditArg.action).toBe("identity.review.auto");
    expect(auditArg.metadata).toMatchObject({ outcome: "approved" });
  });

  it("rejects the submission and the user on a rejected verdict", async () => {
    const prisma = readyPrisma();
    const service = makeService(
      prisma,
      fixedReviewer({
        outcome: "rejected",
        reasonCodes: ["DOB_MISMATCH"],
        dniNumber: "12345678",
      }),
    );

    expect(await service.evaluate("user-1")).toBe(false);
    expect(firstCallArg(prisma.userVerification.update).data).toMatchObject({
      status: VerificationStatus.REJECTED,
      dniNumber: "12345678",
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { verificationStatus: VerificationStatus.REJECTED },
    });
  });

  it("keeps an inconclusive case pending, storing the report", async () => {
    const prisma = readyPrisma();
    const service = makeService(
      prisma,
      fixedReviewer({
        outcome: "inconclusive",
        reasonCodes: ["NO_AUTHORITATIVE_SOURCE"],
        matchReport: { reasonCodes: ["NO_AUTHORITATIVE_SOURCE"] },
      }),
    );

    expect(await service.evaluate("user-1")).toBe(false);
    // Sin cambio de estado: sigue ID_SUBMITTED para la cola del admin.
    expect(prisma.user.update).not.toHaveBeenCalled();
    const data = firstCallArg(prisma.userVerification.update).data as Record<
      string,
      unknown
    >;
    expect(data.status).toBeUndefined();
    expect(data.matchReport).toEqual({
      reasonCodes: ["NO_AUTHORITATIVE_SOURCE"],
    });
  });

  it("leaves the case pending under the manual reviewer", async () => {
    const prisma = readyPrisma();
    const service = makeService(prisma, new ManualReviewer());

    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not verify when the document already verified another account", async () => {
    const prisma = readyPrisma({ id: "otra-verificacion" });
    const service = makeService(
      prisma,
      fixedReviewer({
        outcome: "approved",
        reasonCodes: [],
        dniNumber: "12345678",
      }),
    );

    expect(await service.evaluate("user-1")).toBe(false);
    // Cae a revisión manual con el motivo correspondiente.
    const data = firstCallArg(prisma.userVerification.update).data as {
      notes?: string;
    };
    expect(data.notes).toContain("otra cuenta");
  });

  it("degrades to manual review when the reviewer throws", async () => {
    const prisma = readyPrisma();
    const service = makeService(prisma, {
      name: "explosivo",
      review: () => Promise.reject(new Error("proveedor caído")),
    });

    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userVerification.update).toHaveBeenCalled();
  });

  it("degrades to manual review when the reviewer times out", async () => {
    const prisma = readyPrisma();
    const audit = auditLog();
    const slowConfig = {
      get: (key: string) =>
        key === "IDENTITY_REVIEW_TIMEOUT_MS" ? "10" : undefined,
    } as unknown as ConfigService;

    const service = new IdentityReviewService(
      prisma as unknown as PrismaService,
      {
        name: "lento",
        review: () => new Promise(() => undefined),
      },
      audit.service,
      slowConfig,
    );

    expect(await service.evaluate("user-1")).toBe(false);
    expect(firstCallArg(audit.create).metadata).toMatchObject({
      outcome: "inconclusive",
      reasonCodes: ["REVIEW_TIMEOUT"],
    });
  });

  it("never puts extracted document data in the audit log", async () => {
    const prisma = readyPrisma();
    const audit = auditLog();
    const service = makeService(
      prisma,
      fixedReviewer({
        outcome: "approved",
        reasonCodes: [],
        dniNumber: "12345678",
        extracted: { ocr: { nombre: "JUAN CARLOS" } },
      }),
      audit,
    );

    await service.evaluate("user-1");
    const auditArg = firstCallArg(audit.create);
    expect(JSON.stringify(auditArg)).not.toContain("JUAN CARLOS");
    expect(JSON.stringify(auditArg)).not.toContain("12345678");
  });
});
