import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.factory";
import { EmailService } from "../../src/email/email.service";
import { SmsService } from "../../src/sms/sms.service";
import { CloudinaryService } from "../../src/media/cloudinary.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { FakeEmailService } from "./email.fake";
import { FakeSmsService } from "./sms.fake";
import { FakeCloudinaryService } from "./cloudinary.fake";

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  email: FakeEmailService;
  sms: FakeSmsService;
  cloudinary: FakeCloudinaryService;
}

export interface TestAppOptions {
  /**
   * Credenciales de storage. El adaptador real está fakeado, así que alcanzan
   * valores dummy; se pasan cuando la suite ejercita el circuito de documentos
   * y el .env del repo las trae vacías.
   */
  withStorageEnv?: boolean;
}

/**
 * Boots the full Nest app for E2E tests: same global pipes/filter as production
 * (via configureApp), with the external-service adapters (email, SMS,
 * Cloudinary) replaced by in-memory fakes so codes and documents can be driven
 * and asserted without network access.
 *
 * No hay fake de lector de documentos porque ya no hay lector: este backend
 * guarda las fotos y un admin las revisa. La lectura automática vive en
 * docverify-api/, que es un servicio aparte con sus propios tests.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestContext> {
  const email = new FakeEmailService();
  const sms = new FakeSmsService();
  const cloudinary = new FakeCloudinaryService();

  const envOverrides: Record<string, string> = options.withStorageEnv
    ? {
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
    return { app, prisma, email, sms, cloudinary };
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
