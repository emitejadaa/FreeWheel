import { Logger, ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import cors from "cors";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { join } from "path";

import { AppModule } from "./app.module";
import { createCorsOptions } from "./cors.config";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

const logger = new Logger("Bootstrap");

let cachedServer: Express | null = null;
let cachedApp: Promise<INestApplication> | null = null;

/**
 * Applies the global pipes, filters and body parsing that every environment
 * must share. Exported so the E2E test harness can build an app that behaves
 * exactly like the one served in production.
 */
export function configureApp(app: INestApplication): void {
  // Los avisos de Mercado Pago NO necesitan el cuerpo crudo: la firma se
  // calcula sobre el id del recurso, el request-id y la hora (ver
  // mercadopago.shared.ts), no sobre los bytes del cuerpo. Así que van por el
  // parser de JSON de siempre. El cuerpo crudo era una necesidad de Stripe.

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

  // CORS NO se habilita acá: lo resuelve createServer() antes de que esto
  // arranque. Ver el comentario en createServer.
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

    // Nadie necesita saber con qué está hecho el servidor. No es una
    // protección en sí —quien busque va a deducirlo igual—, pero es lo
    // primero que mira un escaneo automático para elegir qué exploits probar.
    cachedServer.disable("x-powered-by");

    // Cabeceras de seguridad. CSP off y CORP cross-origin porque el front
    // vive en otro dominio y consume esta API por CORS.
    cachedServer.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" },
      }),
    );

    /*
      CORS ACÁ ARRIBA, Y NO ADENTRO DE NEST. ESTE ERA EL BUG.

      Estaba en bootstrapNest, o sea que las cabeceras CORS recién existían
      DESPUÉS de que Nest terminara de levantar. Y Nest levanta de forma
      perezosa, en el middleware de más abajo, la primera vez que llega un
      pedido. Consecuencias, las dos vistas en producción:

      · En un arranque en frío, el navegador pregunta con un OPTIONS y se lo
        contesta la cadena de express ANTES de que exista el CORS de Nest. Sin
        cabeceras, el navegador cancela el pedido de verdad. Eso es el
        "Response to preflight request doesn't pass access control check" que
        se ve en la consola con la home diciendo que no se pudo conectar.

      · Y si Nest FALLA al levantar —una variable que falta, la base que no
        responde— el error sale por el manejador de express sin ninguna
        cabecera CORS. El navegador entonces informa un problema de CORS, que
        es mentira: el problema es el de abajo, pero queda tapado por este y se
        pierde media tarde buscando dónde está mal la lista de orígenes.

      Puesto acá, el preflight se contesta siempre, el arranque en frío deja de
      fallar, y cuando algo se rompa el navegador va a mostrar el error de
      verdad en vez de uno de CORS.
    */
    cachedServer.use(cors(createCorsOptions() as cors.CorsOptions));

    // Front de prueba de la verificación documental (public/demo). Servirlo
    // desde el propio backend lo deja en el MISMO origen: sin CORS de por
    // medio, un error de verificación es siempre del flujo y no del navegador.
    // En Vercel esta carpeta ya la sirve el CDN antes de llegar a la función.
    // Sin caché a propósito: es una consola de depuración que se edita a
    // mano, y una copia vieja en el navegador firma la subida distinto que el
    // backend — el síntoma es un "Invalid Signature" de Cloudinary imposible
    // de atribuir. Que siempre se sirva la última versión del archivo.
    cachedServer.use(
      "/demo",
      express.static(join(process.cwd(), "public", "demo"), {
        etag: false,
        lastModified: false,
        setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
      }),
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

    /*
      Si Nest no llegó a levantar, el pedido nunca entra al filtro de
      excepciones de la aplicación: muere acá. Sin esto lo contesta el
      manejador de express, que devuelve una página HTML de error, y el front
      —que espera JSON— no tiene nada que mostrar mas que "algo salió mal".

      Devolver el motivo en JSON, con la hora, es lo que permite mirar la
      consola del navegador y saber si lo que falló fue la base, una variable o
      el arranque, en vez de adivinar.
    */
    cachedServer.use(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        const cuando = new Date().toISOString();
        logger.error(`La API no pudo atender el pedido (${cuando})`, err);
        res.status(503).json({
          code: "API_NO_DISPONIBLE",
          message: err?.message ?? "La API no pudo iniciarse",
          at: cuando,
        });
      },
    );
  }

  return cachedServer;
}
