import { Logger, ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";

import { AppModule } from "./app.module";
import { createCorsOptions } from "./cors.config";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

const logger = new Logger("Bootstrap");

let cachedServer: Express | null = null;
let cachedApp: Promise<INestApplication> | null = null;

async function bootstrapNest(expressApp: Express): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
  );

  app.enableCors(createCorsOptions());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

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
