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
      "no se puede verificar el DNI ni la licencia: ahí viven las fotos, y sin " +
      "eso la verificación automática queda deshabilitada",
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
      DOCVERIFY_MODE: process.env.DOCVERIFY_MODE ?? "auto (defecto)",
      PAYMENTS_PROVIDER: process.env.PAYMENTS_PROVIDER ?? "mock (defecto)",
      SMS_PROVIDER: process.env.SMS_PROVIDER ?? "mock (defecto)",
      REQUIRE_PHONE_VERIFICATION:
        process.env.REQUIRE_PHONE_VERIFICATION ?? "false (defecto)",
      GROQ_VISION_MODEL:
        process.env.GROQ_VISION_MODEL ?? "sin forzar (usa los del código)",
    },
  };
}
