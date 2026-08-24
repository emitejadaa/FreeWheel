import { config } from "dotenv";
import { resolve } from "path";

// Runs in every worker BEFORE the test files (and therefore before AppModule /
// Prisma are imported), so the app uses the test database, not the dev one.
config({ path: resolve(process.cwd(), ".env.test"), override: true });

// La revisión de documentos se elige por DOCVERIFY_MODE y su default es
// "auto", que sin credenciales de Cloudinary (o sin el verificador Python
// instalado) degrada a "manual": ninguna cuenta se verifica sola y los specs
// que esperan una cuenta VERIFIED fallan. `.env.test` fija auto_approve, pero
// cuando las variables vienen del entorno (CI) no hay ningún `.env.test` que
// las traiga y la suite quedaba atada a una variable que nadie define. El
// default se completa acá para que el resultado no dependa de cómo se cargó
// el entorno; quien quiera otro modo lo sigue fijando (`.env.test`, el
// entorno, o createTestApp por spec) y ese valor gana.
if (!process.env.DOCVERIFY_MODE) {
  process.env.DOCVERIFY_MODE = "auto_approve";
}
