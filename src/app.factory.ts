import { ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";

import { AppModule } from "./app.module";
import { createCorsOptions, parseCorsOrigins } from "./cors.config";

let cachedServer: Express | null = null;
let cachedApp: Promise<INestApplication> | null = null;

async function bootstrapNest(expressApp: Express): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
  );

  app.enableCors(createCorsOptions(parseCorsOrigins()));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();

  return app;
}

export function createServer(): Express {
  if (!cachedServer) {
    cachedServer = express();
    cachedApp = bootstrapNest(cachedServer);

    cachedServer.use(
      async (_req: Request, _res: Response, next: NextFunction) => {
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
