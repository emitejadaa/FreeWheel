import { Logger, ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";

import { AppModule } from "./app.module";
import { createCorsOptions } from "./cors.config";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

const logger = new Logger("Bootstrap");

let cachedServer: Express | null = null;
let cachedApp: Promise<INestApplication> | null = null;

/**
 * Applies the global pipes and filters that every environment must share.
 * Exported so the E2E test harness can build an app that behaves exactly like
 * the one served in production.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
}

async function bootstrapNest(expressApp: Express): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
  );

  app.enableCors(createCorsOptions());
  configureApp(app);

  await app.init();

  // One-line readiness summary on every (cold) start so it is clear which
  // optional integrations are active in the running environment.
  const env = process.env.NODE_ENV ?? "development";
  logger.log(`NestJS application initialized (env: ${env})`);
  logger.log(
    `Email: ${process.env.GMAIL_USER ? "configured" : "disabled"} | ` +
      `Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? "enabled" : "disabled"}`,
  );

  return app;
}

export function createServer(): Express {
  if (!cachedServer) {
    cachedServer = express();

    // Cabeceras de seguridad. CSP off y CORP cross-origin porque el front
    // vive en otro dominio y consume esta API por CORS.
    cachedServer.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" },
      }),
    );

    // El webhook de Stripe necesita el body crudo (Buffer) para verificar la
    // firma. Se registra ANTES del JSON parser global y solo para esa ruta, así
    // el resto de la API sigue recibiendo JSON parseado.
    cachedServer.use(
      "/payments/stripe/webhook",
      express.raw({ type: "*/*", limit: "1mb" }),
    );

    // Límite de body amplio para el proxy de visión (imagen en base64).
    cachedServer.use(express.json({ limit: "8mb" }));
    cachedServer.use(express.urlencoded({ extended: true, limit: "8mb" }));

    cachedServer.use(
      async (_req: Request, _res: Response, next: NextFunction) => {
        if (!cachedApp) {
          cachedApp = bootstrapNest(cachedServer!).catch((err: unknown) => {
            logger.error("NestJS initialization failed", err as Error);
            cachedApp = null;
            throw err;
          });
        }
        try {
          await cachedApp;
          next();
        } catch (error) {
          next(error);
        }
      },
    );
  }

  return cachedServer;
}
