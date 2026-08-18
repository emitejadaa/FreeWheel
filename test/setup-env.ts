import { config } from "dotenv";
import { resolve } from "path";

// Runs in every worker BEFORE the test files (and therefore before AppModule /
// Prisma are imported), so the app uses the test database, not the dev one.
config({ path: resolve(process.cwd(), ".env.test"), override: true });

// El reviewer de identidad se elige por IDENTITY_REVIEW_MODE y su default es
// "document_ai", que sin credenciales de Cloudinary/Groq degrada a "manual":
// ninguna cuenta se verifica sola y los specs que esperan una cuenta VERIFIED
// fallan. `.env.test` fija auto_approve, pero cuando las variables vienen del
// entorno (CI) no hay ningún `.env.test` que las traiga y la suite quedaba
// atada a una variable que nadie define. El default se completa acá para que
// el resultado no dependa de cómo se cargó el entorno; quien quiera otro modo
// lo sigue fijando (`.env.test`, el entorno, o createTestApp por spec) y ese
// valor gana.
if (!process.env.IDENTITY_REVIEW_MODE) {
  process.env.IDENTITY_REVIEW_MODE = "auto_approve";
}
