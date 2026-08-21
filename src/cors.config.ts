import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

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

/** Separa una lista escrita en una variable de entorno, sin dejar vacíos. */
function lista(valor: string | undefined): string[] {
  return (valor ?? "")
    .split(",")
    .map((origen) => origen.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * Quién puede llamar a esta API desde un navegador.
 *
 * ANTES: `origin: true`, o sea que la API contestaba a cualquier sitio web. El
 * token viaja en la cabecera Authorization y no en una cookie, así que eso no
 * alcanzaba para robar una sesión, pero sí dejaba que cualquier página usara
 * nuestras rutas públicas desde el navegador de sus visitantes: por ejemplo el
 * chatbot, que gasta cuota de nuestra API key.
 *
 * AHORA: una lista.
 *  · CORS_ORIGINS, si está cargada, MANDA y es la lista completa (modo estricto:
 *    ni localhost ni las vistas previas, solo lo que diga la variable);
 *  · si no está, se permite el front de producción (FRONTEND_URL), los puertos de
 *    desarrollo y los deploys de vista previa de Vercel, que cambian de nombre en
 *    cada rama y sin esto quedarían todos afuera;
 *  · DEMO_ORIGINS se suma en los dos casos, para el front de prueba.
 *
 * Un pedido SIN cabecera Origin (curl, Postman, el webhook de Stripe, cualquier
 * cosa que no sea un navegador) se deja pasar: CORS es una protección del
 * navegador, y bloquear ahí no agrega seguridad y rompe las integraciones.
 */
export function createCorsOptions(): CorsOptions {
  const explicitos = lista(process.env.CORS_ORIGINS);
  const estricto = explicitos.length > 0;
  // DEMO_ORIGINS se suma SIEMPRE, también en modo estricto: es para poder
  // abrir el front de prueba de la verificación de documentos contra el
  // backend desplegado sin tener que tocar la lista de producción. Es
  // temporal; cuando termine esa etapa, se saca la variable y listo.
  const permitidos = [
    ...(estricto
      ? explicitos
      : [...lista(process.env.FRONTEND_URL), ...DEV_ORIGINS]),
    ...lista(process.env.DEMO_ORIGINS),
  ];

  return {
    origin(origen, callback) {
      if (!origen) return callback(null, true);

      const limpio = origen.replace(/\/$/, "");
      const permitido =
        permitidos.includes(limpio) ||
        (!estricto && VERCEL_PREVIEW.test(limpio));

      // Sin excepción: si se lanzara un error acá, un origen no permitido
      // recibiría un 500 en vez de quedarse sin cabeceras CORS, que es la forma
      // correcta de decir "no" (y la que el navegador explica bien en consola).
      callback(null, permitido);
    },
    methods: ALLOWED_METHODS,
    allowedHeaders: undefined,
    exposedHeaders: ["*"],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };
}
