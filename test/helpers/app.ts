import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.factory";
import { EmailService } from "../../src/email/email.service";
import { SmsService } from "../../src/sms/sms.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { FakeEmailService } from "./email.fake";
import { FakeSmsService } from "./sms.fake";

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  email: FakeEmailService;
  sms: FakeSmsService;
}

/**
 * Boots the full Nest app for E2E tests: same global pipes/filter as production
 * (via configureApp), with EmailService and SmsService replaced by in-memory
 * fakes so emailed/texted codes and tokens can be asserted.
 */
export async function createTestApp(): Promise<TestContext> {
  const email = new FakeEmailService();
  const sms = new FakeSmsService();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EmailService)
    .useValue(email)
    .overrideProvider(SmsService)
    .useValue(sms)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma, email, sms };
}
