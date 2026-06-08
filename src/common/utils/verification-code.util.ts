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
 * verification flows previously duplicated. On a wrong code the attempt counter
 * is incremented before throwing; on success the record is marked consumed and
 * returned. Only one unconsumed code exists per (user, purpose) at a time, so
 * fetching the latest unconsumed record is unambiguous.
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
  if (record.attempts >= record.maxAttempts) throw errors.tooManyAttempts();

  const matches = await bcrypt.compare(plaintext, record.codeHash);
  if (!matches) {
    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw errors.invalid();
  }

  await prisma.verificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  return record;
}
