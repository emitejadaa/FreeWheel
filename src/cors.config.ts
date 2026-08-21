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

/** ¿Está activada la lista blanca? Solo con CORS_STRICT="true". */
export function corsEstricto(): boolean {
  return (process.env.CORS_STRICT ?? "").trim().toLowerCase() === "true";
}

/**
 * Quién puede llamar a esta API desde un navegador.
 *
 * HOY: CUALQUIERA. Se contesta con la cabecera CORS a cualquier origen que
 * pregunte. Es una decisión tomada a propósito mientras se prueba la
 * verificación de documentos desde un HTML suelto: la lista blanca obligaba a
 * cargar una variable y redeployar cada vez que cambiaba el puerto o la
 * máquina desde la que se prueba, y eso frenaba todo el tiempo.
 *
 * QUÉ SIGNIFICA Y QUÉ NO. El token de sesión viaja en la cabecera
 * Authorization, no en una cookie, así que una página ajena NO puede leerlo ni
 * usar la sesión de quien la visita: para llamar a una ruta con sesión hay que
 * tener el token, y para eso hay que habérselo dado. Lo que sí queda abierto
 * son las rutas PÚBLICAS —el chatbot de `POST /ai/chat` sobre todo—, que
 * gastan cuota de nuestra API key: cualquier sitio puede hacérselas llamar a
 * sus visitantes y la factura es nuestra. El tope por IP del throttler es lo
 * único que lo acota.
 *
 * CÓMO SE VUELVE ATRÁS: cargando CORS_STRICT="true". Ahí vuelve la lista de
 * antes: CORS_ORIGINS si está (y manda ella sola), o el front de producción
 * más los puertos de desarrollo y las vistas previas de Vercel. DEMO_ORIGINS
 * se suma en los dos casos. Si además se pasa a autenticar con cookies, esto
 * hay que cerrarlo SÍ O SÍ antes.
 *
 * Un pedido SIN cabecera Origin (curl, Postman, el webhook de Stripe) pasa
 * siempre: CORS es una protección del navegador y bloquear ahí no agrega
 * seguridad, solo rompe integraciones.
 */
export function createCorsOptions(): CorsOptions {
  const estricto = corsEstricto();
  const explicitos = lista(process.env.CORS_ORIGINS);
  const permitidos = [
    ...(explicitos.length > 0
      ? explicitos
      : [...lista(process.env.FRONTEND_URL), ...DEV_ORIGINS]),
    ...lista(process.env.DEMO_ORIGINS),
  ];

  return {
    origin(origen, callback) {
      if (!origen || !estricto) return callback(null, true);

      const limpio = origen.replace(/\/$/, "");
      const permitido =
        permitidos.includes(limpio) ||
        (explicitos.length === 0 && VERCEL_PREVIEW.test(limpio));

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
