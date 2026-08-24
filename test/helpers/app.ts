import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.factory";
import { EmailService } from "../../src/email/email.service";
import { SmsService } from "../../src/sms/sms.service";
import { CloudinaryService } from "../../src/media/cloudinary.service";
import { PythonDocverifyService } from "../../src/verification/docverify/python-docverify.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { FakeEmailService } from "./email.fake";
import { FakeSmsService } from "./sms.fake";
import { FakeCloudinaryService } from "./cloudinary.fake";
import { FakePythonDocverifyService } from "./identity.fake";

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  email: FakeEmailService;
  sms: FakeSmsService;
  cloudinary: FakeCloudinaryService;
  docverify: FakePythonDocverifyService;
}

export interface TestAppOptions {
  /**
   * Modo de revisión de documentos. Por defecto queda el del entorno
   * (auto_approve en .env.test), que es lo que asumen las suites que solo
   * necesitan una cuenta verificada. Pasar "auto" para ejercitar el flujo
   * completo con el verificador Python fakeado.
   */
  docverifyMode?: "auto" | "manual" | "auto_approve";
  /**
   * Si el verificador está instalado. `false` reproduce un servidor que pidió
   * "auto" y no puede cumplirlo —Vercel serverless, sin Python ni tesseract—,
   * que es donde el modo efectivo pasa a ser "unavailable".
   */
  docverifyAvailable?: boolean;
}

/**
 * Boots the full Nest app for E2E tests: same global pipes/filter as production
 * (via configureApp), with the external-service adapters (email, SMS,
 * Cloudinary, lector de códigos y OCR) replaced by in-memory fakes so codes,
 * documents and verdicts can be driven and asserted without network access.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  const email = new FakeEmailService();
  const sms = new FakeSmsService();
  const cloudinary = new FakeCloudinaryService();
  const docverify = new FakePythonDocverifyService();
  if (options.docverifyAvailable === false) docverify.makeUnavailable();

  // El modo auto exige credenciales de storage al arrancar; los adaptadores
  // reales están fakeados, así que alcanzan valores dummy. Se asignan sin
  // condición (el .env del repo trae estas claves vacías) y se restauran al
  // salir para no contaminar otras suites.
  const envOverrides: Record<string, string> = options.docverifyMode
    ? {
        DOCVERIFY_MODE: options.docverifyMode,
        CLOUDINARY_CLOUD_NAME: "test-cloud",
        CLOUDINARY_API_KEY: "test-key",
        CLOUDINARY_API_SECRET: "test-secret",
      }
    : {};
  const previousEnv = new Map(
    Object.keys(envOverrides).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, envOverrides);

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue(email)
      .overrideProvider(SmsService)
      .useValue(sms)
      .overrideProvider(CloudinaryService)
      .useValue(cloudinary)
      .overrideProvider(PythonDocverifyService)
      .useValue(docverify.asService())
      // El suite corre decenas de requests desde la misma IP contra rutas con
      // límites pensados para producción (p. ej. 5 submits de identidad cada 15
      // minutos). El rate limiting es infraestructura, no comportamiento de
      // dominio: con un storage que nunca acumula hits el guard sigue en la
      // cadena pero jamás bloquea, y los tests quedan deterministas.
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 0,
            timeToExpire: 0,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const prisma = app.get(PrismaService);
    return { app, prisma, email, sms, cloudinary, docverify };
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
