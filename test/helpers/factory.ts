import type { INestApplication } from "@nestjs/common";
import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { PrismaService } from "../../src/prisma/prisma.service";
import { EmailService } from "../../src/email/email.service";
import { cuilChecksumValid } from "../../src/common/utils/cuil.util";
import type { FakeEmailService } from "./email.fake";

export const TEST_PASSWORD = "TestPass123!";
export const TEST_DATE_OF_BIRTH = "1990-01-01";
export const TEST_ADDRESS = "Av. Siempre Viva 742, Springfield, CABA";

let seq = 0;
let dniSeq = 0;

/** Unique, valid email per call so tests never collide on the unique constraint. */
export function uniqueEmail(prefix = "user"): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@test.local`;
}

/** Unique 8-digit DNI per call (User.dni has a unique index). */
export function uniqueDni(): string {
  dniSeq += 1;
  return String(20000000 + dniSeq);
}

/**
 * Valid person CUIL for a DNI. Starts from the prefix that matches the sex
 * (20 = M, 27 = F) and falls back to the sex-neutral 23/24 when the mod-11
 * check digit would not exist — exactly how real CUILs are assigned. Picking
 * the opposite-sex prefix would (rightly) trip the CUIL_SEX_MISMATCH check.
 */
export function cuilFor(dni: string, sex: "M" | "F" = "M"): string {
  for (const prefix of [sex === "M" ? "20" : "27", "23", "24"]) {
    const base = `${prefix}${dni.padStart(8, "0")}`;
    for (let digit = 0; digit <= 9; digit += 1) {
      const candidate = `${base}${digit}`;
      if (cuilChecksumValid(candidate)) return candidate;
    }
  }
  throw new Error(`cuilFor: no valid CUIL exists for DNI ${dni}`);
}

/**
 * Fills the manually-entered identity data (dni/cuil/address) via the public
 * PATCH /users/me route; the verification checklist requires all three.
 */
export async function setIdentityProfile(
  app: INestApplication,
  token: string,
  overrides: Partial<{ dni: string; cuil: string; address: string }> = {},
): Promise<{ dni: string; cuil: string; address: string }> {
  const dni = overrides.dni ?? uniqueDni();
  const identity = {
    dni,
    cuil: overrides.cuil ?? cuilFor(dni),
    address: overrides.address ?? TEST_ADDRESS,
  };
  await request(app.getHttpServer())
    .patch("/users/me")
    .set("Authorization", `Bearer ${token}`)
    .send(identity)
    .expect(200);
  return identity;
}

/** A Date `days` in the future (booking dates must be in the future). */
export function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export interface AuthedUser {
  token: string;
  id: string;
  email: string;
  password: string;
}

/**
 * Registers a fresh user through the two-step email-first flow
 * (register/start → capture the emailed code from the fake → register/complete)
 * and returns its token + identity.
 *
 * Defaults to a FULLY verified account (phone verified + VERIFIED status) so the
 * many specs that exercise gated routes (vehicles, listings, bookings, payments,
 * contracts) keep working. Pass `{ verified: false }` to get an account that has
 * only its email verified — used by the verification and gate specs.
 */
export async function registerUser(
  app: INestApplication,
  overrides: Partial<{
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    verified: boolean;
  }> = {},
): Promise<AuthedUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? TEST_PASSWORD;
  const verified = overrides.verified ?? true;

  // EmailService is overridden with the in-memory fake in createTestApp, so this
  // is where the registration code lands.
  const emailFake = app.get(EmailService) as unknown as FakeEmailService;

  await request(app.getHttpServer())
    .post("/auth/register/start")
    .send({ email })
    .expect(201);

  const code = emailFake.lastCode(email);
  if (!code) {
    throw new Error(`registerUser: no verification code captured for ${email}`);
  }

  const res = await request(app.getHttpServer())
    .post("/auth/register/complete")
    .send({
      email,
      code,
      password,
      firstName: overrides.firstName ?? "Test",
      lastName: overrides.lastName ?? "User",
      acceptedTerms: true,
      dateOfBirth: overrides.dateOfBirth ?? TEST_DATE_OF_BIRTH,
    })
    .expect(201);

  const authed: AuthedUser = {
    token: res.body.accessToken,
    id: res.body.user.id,
    email,
    password,
  };

  if (verified) {
    // JwtStrategy reloads verificationStatus from the DB on every request, so
    // bumping it here makes the already-minted token behave as fully verified.
    // Identity data is seeded too (unique per user) so VERIFIED accounts look
    // like real post-verification accounts.
    const prisma = app.get(PrismaService);
    const dni = uniqueDni();
    await prisma.user.update({
      where: { id: authed.id },
      data: {
        phone: "+5491100000000",
        phoneVerifiedAt: new Date(),
        dni,
        cuil: cuilFor(dni),
        address: TEST_ADDRESS,
        verificationStatus: VerificationStatus.VERIFIED,
      },
    });
  }

  return authed;
}

/** Seeds an ADMIN directly (no public route grants it) and logs in for a token. */
export async function createAdmin(
  app: INestApplication,
  prisma: PrismaService,
): Promise<AuthedUser> {
  const email = uniqueEmail("admin");
  const password = TEST_PASSWORD;

  const user = await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash(password, 10),
      firstName: "Admin",
      lastName: "User",
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      verificationStatus: VerificationStatus.EMAIL_VERIFIED,
      emailVerifiedAt: new Date(),
      // Login only issues a full token once a date of birth is present.
      dateOfBirth: new Date(`${TEST_DATE_OF_BIRTH}T00:00:00.000Z`),
    },
  });

  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ email, password })
    .expect(201);

  return { token: res.body.accessToken, id: user.id, email, password };
}

/** Creates a vehicle owned by the token holder; returns the created record. */
export async function createVehicle(
  app: INestApplication,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; [key: string]: unknown }> {
  const res = await request(app.getHttpServer())
    .post("/vehicles")
    .set("Authorization", bearer(token))
    .send({ brand: "Toyota", model: "Corolla", year: 2020, ...overrides })
    .expect(201);
  return res.body;
}

/** Creates an ACTIVE listing for a vehicle; returns the created record. */
export async function createListing(
  app: INestApplication,
  token: string,
  vehicleId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; [key: string]: unknown }> {
  const res = await request(app.getHttpServer())
    .post("/listings")
    .set("Authorization", bearer(token))
    .send({
      vehicleId,
      title: "Reliable city car",
      description: "Great condition, ideal for city trips.",
      pricePerDay: 5000,
      locationText: "Palermo, CABA",
      status: "ACTIVE",
      ...overrides,
    })
    .expect(201);
  return res.body;
}
