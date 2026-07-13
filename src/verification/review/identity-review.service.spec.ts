import { User, UserVerification, VerificationStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  buildVerificationChecklist,
  hasCompleteDocuments,
  IdentityReviewService,
} from "./identity-review.service";
import { AutoApproveReviewer } from "./auto-approve.reviewer";
import { ManualReviewer } from "./manual.reviewer";

type MockPrisma = {
  user: { findUnique: jest.Mock; update: jest.Mock };
  userVerification: { findFirst: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};

function makePrisma(): MockPrisma {
  return {
    user: { findUnique: jest.fn(), update: jest.fn() },
    userVerification: { findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

function asPrisma(mock: MockPrisma): PrismaService {
  return mock as unknown as PrismaService;
}

const submission = {
  id: "ver-1",
  userId: "user-1",
  status: VerificationStatus.ID_SUBMITTED,
  selfieUrl: null,
  dniFrontUrl: "a",
  dniBackUrl: "b",
  licenseFrontUrl: "c",
  licenseBackUrl: "d",
} as unknown as UserVerification;

const fullyReadyUser = {
  id: "user-1",
  verificationStatus: VerificationStatus.PHONE_VERIFIED,
  emailVerifiedAt: new Date(),
  phoneVerifiedAt: new Date(),
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
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
    });
  });

  it("does not count a rejected submission as submitted", () => {
    const rejected = { ...submission, status: VerificationStatus.REJECTED };
    expect(
      buildVerificationChecklist(fullyReadyUser, rejected).documentsSubmitted,
    ).toBe(false);
  });
});

describe("IdentityReviewService.evaluate", () => {
  it("verifies the account when the checklist is complete (auto-approve)", async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(fullyReadyUser);
    prisma.userVerification.findFirst.mockResolvedValue(submission);

    const service = new IdentityReviewService(
      asPrisma(prisma),
      new AutoApproveReviewer(),
    );
    const result = await service.evaluate("user-1");

    expect(result).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { verificationStatus: VerificationStatus.VERIFIED },
    });
  });

  it("does nothing when the phone is not verified", async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      ...fullyReadyUser,
      phoneVerifiedAt: null,
    });
    prisma.userVerification.findFirst.mockResolvedValue(submission);

    const service = new IdentityReviewService(
      asPrisma(prisma),
      new AutoApproveReviewer(),
    );
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does nothing when the account is already verified", async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      ...fullyReadyUser,
      verificationStatus: VerificationStatus.VERIFIED,
    });

    const service = new IdentityReviewService(
      asPrisma(prisma),
      new AutoApproveReviewer(),
    );
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.userVerification.findFirst).not.toHaveBeenCalled();
  });

  it("does nothing when documents are incomplete", async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(fullyReadyUser);
    prisma.userVerification.findFirst.mockResolvedValue({
      ...submission,
      licenseBackUrl: null,
    });

    const service = new IdentityReviewService(
      asPrisma(prisma),
      new AutoApproveReviewer(),
    );
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves the case pending under the manual reviewer", async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(fullyReadyUser);
    prisma.userVerification.findFirst.mockResolvedValue(submission);

    const service = new IdentityReviewService(
      asPrisma(prisma),
      new ManualReviewer(),
    );
    expect(await service.evaluate("user-1")).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
