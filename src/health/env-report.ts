/**
 * env-report.ts — Qué variables de entorno están cargadas en el servidor
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE: el deploy de este backend lo administra otra persona, así que
 * quien programa no puede abrir el panel de Vercel para ver qué está cargado.
 * Sin esto, la única forma de averiguar si falta una variable era ir probando la
 * app hasta que algo fallara —y algunas fallas son silenciosas: si faltan las
 * credenciales de Cloudinary, las fotos siguen subiendo por un camino sin firmar
 * y nadie se entera—.
 *
 * Lo que devuelve alcanza para pedir exactamente lo que falta, y NADA MÁS:
 * solamente si cada variable tiene algún valor (true/false) y su nombre. Nunca
 * el valor, ni una parte, ni su largo. Un endpoint de diagnóstico que filtra una
 * clave es peor que no tenerlo.
 */

/** Un grupo de variables que habilitan una funcionalidad concreta. */
type Grupo = {
  /** Cómo se llama esto para quien lo lee. */
  feature: string;
  /** Todas tienen que estar para que el grupo cuente como configurado. */
  vars: string[];
  /** Qué pasa si falta. En castellano y concreto, no "no funcionará". */
  consecuencia: string;
};

const OBLIGATORIAS: Grupo[] = [
  {
    feature: "base de datos",
    vars: ["DATABASE_URL"],
    consecuencia: "la API contesta error 500 en todo",
  },
  {
    feature: "sesiones",
    vars: ["JWT_SECRET"],
    consecuencia: "nadie puede iniciar sesión",
  },
];

const OPCIONALES: Grupo[] = [
  {
    // La verificación documental NO usa este modelo: la hace el verificador
    // Python. Groq quedó para el chatbot y la revisión de fotos de vehículos.
    feature: "chatbot y revisión de fotos de vehículos",
    vars: ["GROQ_API_KEY"],
    consecuencia:
      "el chatbot no contesta y las fotos de los autos no se revisan solas",
  },
  {
    feature: "emails (código de registro y recuperar la contraseña)",
    vars: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
    consecuencia: "no se puede terminar de registrarse ni recuperar la clave",
  },
  {
    feature: "documentos de identidad",
    vars: [
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ],
    consecuencia:
      "no se puede verificar el DNI ni la licencia: ahí viven las fotos",
  },
  {
    feature: "lectura automática de documentos",
    vars: ["DOCVERIFY_URL", "DOCVERIFY_TOKEN"],
    consecuencia:
      "los documentos no se leen solos: se guardan igual, pero cada " +
      "verificación espera a que la mire un administrador",
  },
  // DOCVERIFY_PLATFORM_TOKEN no está en la lista a propósito: solo hace falta
  // si el servicio de lectura vive detrás de la autenticación de su plataforma
  // (un Space PRIVADO de Hugging Face). Pedirla siempre haría que este reporte
  // marque como "incompleto" un deploy que está perfecto.
  {
    // Sin esto la API de lectura no tiene a dónde devolver el resultado, así
    // que el análisis ni se pide: es una de esas fallas silenciosas que este
    // reporte existe para hacer visibles. En Vercel VERCEL_URL viene sola.
    feature: "aviso de vuelta de la lectura de documentos",
    vars: ["PUBLIC_URL"],
    consecuencia:
      "en Vercel no hace falta (VERCEL_URL alcanza); fuera de Vercel, la API " +
      "de lectura no sabe a dónde devolver el resultado y todo pasa a " +
      "revisión manual",
  },
  {
    feature: "links de los emails",
    vars: ["FRONTEND_URL"],
    consecuencia: "los links de los mails apuntan a localhost",
  },
  {
    feature: "entrar con Google",
    vars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    consecuencia: "ese botón no funciona; el registro normal sí",
  },
  {
    /*
      PAGOS FALTABA EN ESTA LISTA, Y ES EL GRUPO QUE MÁS FALTA HACE.

      Sin estas dos, `allSet` decía true y el reporte entero se veía perfecto
      mientras NINGUNA reserva se podía pagar. Es justo la falla silenciosa que
      este archivo existe para hacer visible.

      Son dos y hacen cosas distintas, así que conviene entender qué se pierde
      con cada una:

       · STRIPE_SECRET_KEY: sin ella el módulo de pagos arranca con el
         proveedor "sin configurar" y toda operación contesta 503.
       · STRIPE_WEBHOOK_SECRET: con ella faltando los cobros SE HACEN —la
         tarjeta se debita— pero el aviso de Stripe se rechaza por falta de
         firma, así que la reserva se queda impaga para siempre con la plata ya
         cobrada. Es la peor de las dos y la que menos se nota.
    */
    feature: "cobros con tarjeta",
    vars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    consecuencia:
      "sin la clave secreta no se puede pagar ninguna reserva (503); sin la " +
      "del webhook el cobro se hace pero la reserva queda impaga, porque el " +
      "aviso de Stripe se rechaza por falta de firma",
  },
];

export interface EnvReport {
  /** true cuando están todas las obligatorias y todas las opcionales. */
  allSet: boolean;
  /** Por funcionalidad: si está lista o no. */
  features: Record<string, boolean>;
  /** Nombres de variables que faltan, listos para pedirlos. */
  missing: string[];
  /** Qué se pierde por cada cosa que falta. */
  impact: string[];
  /** Modo elegido en las variables, que cambia cómo se comporta la API. */
  modes: Record<string, string>;
}

const cargada = (nombre: string): boolean =>
  typeof process.env[nombre] === "string" && process.env[nombre].trim() !== "";

export function buildEnvReport(): EnvReport {
  const features: Record<string, boolean> = {};
  const missing: string[] = [];
  const impact: string[] = [];

  for (const grupo of [...OBLIGATORIAS, ...OPCIONALES]) {
    const faltan = grupo.vars.filter((v) => !cargada(v));
    features[grupo.feature] = faltan.length === 0;
    if (faltan.length > 0) {
      missing.push(...faltan);
      impact.push(`${grupo.feature}: ${grupo.consecuencia}`);
    }
  }

  return {
    allSet: missing.length === 0,
    features,
    missing,
    impact,
    // Estos NO son secretos: son la forma en que está configurada la API, y
    // saberlos es justo lo que hace falta para entender qué está pasando.
    modes: {
      PAYMENTS_PROVIDER: process.env.PAYMENTS_PROVIDER ?? "stripe (defecto)",
      /*
        EN QUÉ MONEDA SE COBRA, QUE NO ES OBVIO Y ROMPE COSAS.

        De acá sale la moneda que se le graba a cada reserva al aceptarla
        (pricing.service.ts), y esa es la que viaja a Stripe al cobrar. El
        defecto es "usd", NO la moneda del país: una cuenta de Stripe solo
        puede cobrar en las monedas que admite, así que si el defecto no
        coincide, el cobro falla con "Invalid currency" y no hay nada en la app
        que lo explique.

        No es un secreto —es cómo está configurada la API— y saberlo es
        exactamente lo que hace falta para entender por qué un pago no sale.
      */
      DEFAULT_CURRENCY: (
        process.env.DEFAULT_CURRENCY ?? "usd (defecto)"
      ).toLowerCase(),
      SMS_PROVIDER: process.env.SMS_PROVIDER ?? "mock (defecto)",
      REQUIRE_PHONE_VERIFICATION:
        process.env.REQUIRE_PHONE_VERIFICATION ?? "false (defecto)",
      GROQ_VISION_MODEL:
        process.env.GROQ_VISION_MODEL ?? "sin forzar (usa los del código)",
      // Cuántas cuentas administradoras nombra la variable, NO cuáles. La
      // dirección de la cuenta con control total de la plataforma no va en una
      // respuesta que se puede consultar: saber que hay una alcanza para
      // diagnosticar "el panel me da 403".
      ADMIN_EMAILS: cargada("ADMIN_EMAILS")
        ? `${(process.env.ADMIN_EMAILS ?? "").split(/[,\s;]+/).filter(Boolean).length} cuenta(s) configurada(s)`
        : "ninguna (el rol se da desde el panel)",
    },
  };
}
