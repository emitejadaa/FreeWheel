import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.factory";
import { EmailService } from "../../src/email/email.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { FakeEmailService } from "./email.fake";

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  email: FakeEmailService;
}

/**
 * Boots the full Nest app for E2E tests: same global pipes/filter as production
 * (via configureApp), with EmailService replaced by an in-memory fake so emailed
 * codes/tokens can be asserted.
 */
export async function createTestApp(): Promise<TestContext> {
  const email = new FakeEmailService();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailService)
    .useValue(email)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma, email };
}
