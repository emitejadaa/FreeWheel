import { randomInt } from "crypto";

// Verification codes use a cryptographically secure RNG (never Math.random) and a
// single shared TTL so the auth and verification flows cannot drift apart.
export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

export function generateNumericCode(): string {
  return randomInt(100000, 1000000).toString();
}
