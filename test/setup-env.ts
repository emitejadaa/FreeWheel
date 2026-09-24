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

// LA SUITE COBRA EN PESOS, COMO MERCADO PAGO.
//
// Se fija acá y no en .env.test a propósito: ese archivo es de cada máquina
// (y el de una máquina vieja todavía dice "usd", de cuando el procesador era
// Stripe). Mercado Pago Argentina solo cobra en pesos, así que una suite que
// congela las reservas en dólares probaría un camino que en producción
// contesta 409 CURRENCY_NOT_SUPPORTED.
process.env.DEFAULT_CURRENCY = "ars";
// La clave con la que el provider de pruebas verifica los avisos. La misma la
// usa test/helpers/payments.ts para firmarlos.
process.env.MP_WEBHOOK_SECRET ??= "mp_webhook_secret_for_tests";
// El depósito se autoriza cerca del retiro (48 horas antes, por omisión).
// Las reservas de las pruebas empiezan a los pocos días, así que la ventana se
// abre a 30 días para no tener que armar cada reserva para mañana. La prueba
// de "todavía es temprano" usa una reserva de más de 30 días.
process.env.DEPOSIT_AUTH_WINDOW_HOURS = "720";
