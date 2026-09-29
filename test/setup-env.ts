import { config } from "dotenv";
import { resolve } from "path";

// Runs in every worker BEFORE the test files (and therefore before AppModule /
// Prisma are imported), so the app uses the test database, not the dev one.
config({ path: resolve(process.cwd(), ".env.test"), override: true });

// La suite corre SIN DOCVERIFY_URL a propósito, o sea sin lectura automática
// de documentos. Los specs que necesitan una cuenta verificada aprueban los
// documentos por el circuito del admin o escribiendo el estado en la base, que
// es determinístico; depender de un servicio externo —que además tardaría
// segundos por foto— haría la suite lenta y frágil. Lo que se prueba del cruce
// de datos vive en los specs unitarios de IdentityMatchService, donde la
// lectura se puede fijar campo por campo.
