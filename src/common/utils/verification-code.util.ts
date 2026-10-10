import { randomBytes, randomInt } from "crypto";
import { Prisma, VerificationCode } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../prisma/prisma.service";

// Verification codes use a cryptographically secure RNG (never Math.random) and a
// single shared TTL so the auth and verification flows cannot drift apart.
export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

/** Six-digit numeric code (e.g. "428193") for email/phone verification. */
export function generateNumericCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * Opaque hex token used for one-shot secrets (password-reset links, booking
 * pickup/return QR tokens). `bytes` controls entropy; output length is 2×bytes.
 */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export interface ConsumeVerificationCodeOptions {
  /** Discriminating filter (userId + purpose/targetType, optional targetValue). */
  where: Prisma.VerificationCodeWhereInput;
  /** Raw code or token submitted by the caller, compared against the stored hash. */
  plaintext: string;
  /**
   * Exception factory per failure mode. Each flow supplies its own so HTTP
   * status codes and messages stay exactly as they were before unification —
   * e.g. auth maps both `missing` and `expired` to the same BadRequestException,
   * while the verification flow uses NotFound / BadRequest / Forbidden.
   */
  errors: {
    missing: () => Error;
    expired: () => Error;
    tooManyAttempts: () => Error;
    invalid: () => Error;
  };
}

/**
 * Validate and consume a single-use verification code/token. Centralizes the
 * find → expiry → attempts → compare → consume sequence that the auth and
 * verification flows previously duplicated. Only one unconsumed code exists per
 * (user, purpose) at a time, so fetching the latest unconsumed record is
 * unambiguous.
 *
 * The attempt is reserved with a conditional increment BEFORE comparing: with
 * a separate check and increment, N parallel guesses all saw `attempts < max`
 * and the per-code limit did not hold. Consumption is conditional too, so the
 * same code cannot be consumed twice.
 */
export async function consumeVerificationCode(
  prisma: PrismaService,
  { where, plaintext, errors }: ConsumeVerificationCodeOptions,
): Promise<VerificationCode> {
  const record = await prisma.verificationCode.findFirst({
    where: { ...where, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) throw errors.missing();
  if (record.expiresAt <= new Date()) throw errors.expired();

  const reserved = await prisma.verificationCode.updateMany({
    where: {
      id: record.id,
      consumedAt: null,
      attempts: { lt: record.maxAttempts },
    },
    data: { attempts: { increment: 1 } },
  });
  if (reserved.count === 0) {
    const current = await prisma.verificationCode.findUnique({
      where: { id: record.id },
      select: { consumedAt: true },
    });
    throw current?.consumedAt ? errors.missing() : errors.tooManyAttempts();
  }

  if (!(await bcrypt.compare(plaintext, record.codeHash))) {
    throw errors.invalid();
  }

  const consumed = await prisma.verificationCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) throw errors.missing();

  return record;
}
