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
import { expressErrorHandler } from "./common/filters/express-error.handler";

const logger = new Logger("Bootstrap");

let cachedServer: Express | null = null;
let cachedApp: Promise<INestApplication> | null = null;

/** La ruta que necesita el cuerpo del pedido sin parsear. */
export const STRIPE_WEBHOOK_PATH = "/payments/stripe/webhook";

/**
 * Applies the global pipes, filters and body parsing that every environment
 * must share. Exported so the E2E test harness can build an app that behaves
 * exactly like the one served in production.
 */
export function configureApp(app: INestApplication): void {
  // EL CUERPO CRUDO DEL WEBHOOK, ANTES QUE CUALQUIER PARSER.
  //
  // La firma de Stripe se verifica sobre los BYTES EXACTOS que Stripe mandó.
  // Si algo los parsea primero, lo único que queda es un objeto, y
  // reconstruirlo con JSON.stringify da otros bytes —otro orden de claves,
  // otros espacios— así que la verificación falla o, peor, pasa sobre algo que
  // no es lo que Stripe firmó.
  //
  // Esto vivía solo en createServer(), o sea solo en el deploy. Los tests
  // corrían contra un app SIN este middleware y el controlador reconstruía el
  // buffer a mano para que funcionaran: el camino más sensible del sistema se
  // probaba distinto de como corre. Ahora es el mismo en los dos lados.
  app.use(STRIPE_WEBHOOK_PATH, express.raw({ type: "*/*", limit: "1mb" }));

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
  /*
    abortOnError: false NO ES UN DETALLE.

    Por defecto, cuando un proveedor falla al construirse (una variable de
    entorno que falta, la base que no contesta) Nest imprime el error y llama
    a process.abort(). En un servidor de toda la vida se reinicia y listo. Acá
    el proceso ES la función de Vercel: al abortarse, la función muere sin
    contestar nada y Vercel devuelve su propia página de error,

        500: INTERNAL_SERVER_ERROR · FUNCTION_INVOCATION_FAILED

    que no dice qué se rompió. Peor todavía: un proceso muerto tampoco manda
    cabeceras CORS, así que el navegador lo informa como un problema de CORS y
    el error verdadero queda tapado dos veces.

    Con abortOnError en false, create() rechaza la promesa en vez de matar el
    proceso. El error viaja por el .catch de más abajo hasta el manejador del
    final, y el navegador recibe un 503 en JSON con el motivo escrito.
  */
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    { abortOnError: false },
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

    // El webhook de Stripe necesita el body crudo (Buffer) para verificar la
    // firma. Se registra ANTES del JSON parser global y solo para esa ruta, así
    // el resto de la API sigue recibiendo JSON parseado. `configureApp` lo
    // vuelve a registrar sobre el app de Nest para que los tests corran contra
    // lo mismo; express ignora el duplicado porque el primero ya dejó el body
    // puesto.
    cachedServer.use(
      STRIPE_WEBHOOK_PATH,
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

    // Lo que falla antes de Nest (el parser, el arranque) no pasa por el
    // filtro de excepciones: sin esto lo contestaría Express con una página
    // HTML, y el front espera JSON.
    cachedServer.use(expressErrorHandler);
  }

  return cachedServer;
}
