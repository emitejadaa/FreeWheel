import type { INestApplication } from "@nestjs/common";
import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { PrismaService } from "../../src/prisma/prisma.service";

export const TEST_PASSWORD = "TestPass123!";

let seq = 0;

/** Unique, valid email per call so tests never collide on the unique constraint. */
export function uniqueEmail(prefix = "user"): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@test.local`;
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

/** Registers a fresh user through the API and returns its token + identity. */
export async function registerUser(
  app: INestApplication,
  overrides: Partial<{
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }> = {},
): Promise<AuthedUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? TEST_PASSWORD;

  const res = await request(app.getHttpServer())
    .post("/auth/register")
    .send({
      email,
      password,
      firstName: overrides.firstName ?? "Test",
      lastName: overrides.lastName ?? "User",
      acceptedTerms: true,
    })
    .expect(201);

  return { token: res.body.accessToken, id: res.body.user.id, email, password };
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
