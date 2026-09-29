import { Logger } from "@nestjs/common";
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

const logger = new Logger("Cors");

const ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

/** Los puertos con los que se levanta el front en una máquina de desarrollo. */
const DEV_ORIGINS = [
  "http://localhost:5173", // vite dev
  "http://localhost:4173", // vite preview
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://localhost:8080", // `python3 -m http.server 8080`, el front de prueba
  "http://127.0.0.1:8080",
];

/** Los deploys de vista previa de Vercel: un subdominio distinto por rama. */
const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

export type CorsMode = "strict" | "report-only" | "open";

/** Separa una lista escrita en una variable de entorno, sin dejar vacíos. */
function lista(valor: string | undefined): string[] {
  return (valor ?? "")
    .split(",")
    .map((origen) => origen.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * El mismo dominio con y sin "www". Es el error más común de configuración:
 * se carga el apex y el front se sirve desde www (o al revés) y todo el sitio
 * deja de funcionar por un prefijo.
 */
function conGemeloWww(origen: string): string[] {
  try {
    const url = new URL(origen);
    const gemelo = new URL(origen);
    gemelo.hostname = url.hostname.startsWith("www.")
      ? url.hostname.slice(4)
      : `www.${url.hostname}`;
    return [origen, gemelo.origin];
  } catch {
    return [origen];
  }
}

/** La lista blanca ya resuelta, sin repetidos. */
export function origenesPermitidos(): string[] {
  const explicitos = lista(process.env.CORS_ORIGINS);
  const base =
    explicitos.length > 0
      ? explicitos
      : [
          ...lista(process.env.FRONTEND_URL),
          ...lista(process.env.PUBLIC_URL),
          ...DEV_ORIGINS,
        ];

  return [
    ...new Set(
      [...base, ...lista(process.env.DEMO_ORIGINS)].flatMap(conGemeloWww),
    ),
  ];
}

/**
 * EN QUÉ MODO ESTÁ EL CORS.
 *
 *   · "strict"      → se rechaza todo origen fuera de la lista.
 *   · "report-only" → se deja pasar, pero se registra qué se habría rechazado.
 *   · "open"        → se deja pasar cualquier origen, sin registrar nada.
 *
 * CORS_STRICT manda: "true" fuerza strict, "false" fuerza open. Sin esa
 * variable, en producción el modo es report-only y fuera de producción es open.
 *
 * POR QUÉ REPORT-ONLY EXISTE. Prender la lista blanca a ciegas es la forma más
 * rápida de dejar el front publicado sin backend: alcanza con que FRONTEND_URL
 * tenga el dominio viejo, o el apex en vez de www, para que el navegador
 * empiece a rechazar todas las llamadas. En report-only la API sigue
 * respondiendo igual y en los logs aparece "CORS report-only: pasaría a
 * rechazar <origen>". Se mira esa línea, se confirma que el origen del front
 * esté en la lista, y recién ahí se carga CORS_STRICT=true.
 *
 * Y si la lista quedara vacía, strict se degrada solo a report-only: una lista
 * vacía no protege nada, solo apaga el servicio para todos.
 */
export function corsMode(): CorsMode {
  const bandera = (process.env.CORS_STRICT ?? "").trim().toLowerCase();
  if (bandera === "false" || bandera === "0") return "open";

  const pedido: CorsMode =
    bandera === "true" || bandera === "1"
      ? "strict"
      : process.env.NODE_ENV === "production"
        ? "report-only"
        : "open";

  if (pedido === "strict" && origenesPermitidos().length === 0) {
    logger.error(
      "CORS_STRICT=true sin ningún origen configurado (CORS_ORIGINS / " +
        "FRONTEND_URL): se queda en report-only para no dejar el front sin API.",
    );
    return "report-only";
  }

  return pedido;
}

/** Sigue existiendo para el reporte de entorno y los tests viejos. */
export function corsEstricto(): boolean {
  return corsMode() === "strict";
}

/**
 * Quién puede llamar a esta API desde un navegador.
 *
 * QUÉ PROTEGE Y QUÉ NO. El token de sesión viaja en la cabecera Authorization,
 * no en una cookie, así que una página ajena NO puede usar la sesión de quien
 * la visita: para llamar a una ruta con sesión hay que tener el token, y para
 * eso hay que habérselo dado. Lo que la lista blanca sí frena son las rutas
 * PÚBLICAS —`POST /ai/chat` sobre todo—, que gastan cuota de nuestra API key:
 * cualquier sitio puede hacérselas llamar a sus visitantes y la factura es
 * nuestra. Si algún día se pasa a autenticar con cookies, esto hay que cerrarlo
 * SÍ O SÍ antes.
 *
 * Un pedido SIN cabecera Origin (curl, Postman, el webhook de Stripe) pasa
 * siempre: CORS es una protección del navegador y bloquear ahí no agrega
 * seguridad, solo rompe integraciones.
 */
export function createCorsOptions(): CorsOptions {
  const modo = corsMode();
  const permitidos = origenesPermitidos();
  const sinLista = process.env.CORS_ORIGINS ? false : true;

  logger.log(
    `CORS en modo ${modo} (${permitidos.length} orígenes en la lista)` +
      (modo === "report-only"
        ? " — cargá CORS_STRICT=true cuando confirmes el origen del front."
        : ""),
  );

  return {
    origin(origen, callback) {
      if (!origen || modo === "open") return callback(null, true);

      const limpio = origen.replace(/\/$/, "");
      const permitido =
        permitidos.includes(limpio) ||
        (sinLista && VERCEL_PREVIEW.test(limpio));

      if (!permitido && modo === "report-only") {
        logger.warn(`CORS report-only: pasaría a rechazar ${limpio}`);
        return callback(null, true);
      }

      // Sin excepción: si se lanzara un error acá, un origen no permitido
      // recibiría un 500 en vez de quedarse sin cabeceras CORS, que es la forma
      // correcta de decir "no" (y la que el navegador explica bien en consola).
      callback(null, permitido);
    },
    methods: ALLOWED_METHODS,
    allowedHeaders: undefined,
    exposedHeaders: ["*"],
    // Se refleja el origen que pregunta en vez de mandar "*": con
    // credentials en true, un "*" literal lo rechaza el propio navegador.
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };
}
