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

// ⚠️ TEMPORAL — MODO DEMO APAGADO EN LA SUITE. Ver src/common/demo-mode.ts.
//
// El modo demo relaja los controles (edad, vencimiento, principiante, clase)
// para poder recorrer los flujos desde el front sin quedar trabado. Lo que la
// suite tiene que seguir cuidando son las reglas DE VERDAD: si corriera con el
// modo encendido, los tests que dicen "una licencia vencida no deja alquilar"
// pasarían a afirmar lo contrario, y al revertir el andamio nadie se enteraría
// de lo que se rompió mientras tanto.
//
// Se apaga acá y no en cada spec porque el modo es global: un solo lugar que
// desaparece con el revert.
process.env.VERIFICATION_DEMO_MODE = "false";
