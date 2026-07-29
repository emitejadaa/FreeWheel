/* eslint-disable */
/**
 * Aplica las migraciones pendientes durante el deploy.
 *
 * ¿Por qué acá y no en vercel.json? Porque vercel.json usa el formato viejo con
 * "builds", y cuando ese campo está presente Vercel IGNORA "buildCommand". O
 * sea: el `prisma migrate deploy` que estaba configurado ahí nunca se ejecutó, y
 * la base quedó sin las tablas y columnas nuevas. El síntoma era error 500 en
 * /listings y /favorites, porque Prisma consultaba columnas que no existían.
 *
 * El paso "install" sí corre siempre, así que enganchamos las migraciones al
 * postinstall. Solo actúa en el deploy (VERCEL=1) y con DATABASE_URL cargada,
 * para no tocar nunca la base de nadie al hacer `npm install` en su máquina.
 */
const { execSync } = require("child_process");

const isVercel = Boolean(process.env.VERCEL);
const hasDatabase = Boolean(process.env.DATABASE_URL);
// `npm run db:migrate:prod` pasa --force para aplicarlas a mano desde la consola.
const forced =
  process.argv.includes("--force") || process.env.RUN_MIGRATIONS === "true";

if (!forced && !isVercel) {
  console.log("[migrate] Fuera del deploy: no se aplican migraciones.");
  process.exit(0);
}

if (!hasDatabase) {
  console.log("[migrate] Sin DATABASE_URL: no se aplican migraciones.");
  process.exit(0);
}

try {
  console.log("[migrate] Aplicando migraciones pendientes...");
  execSync("prisma migrate deploy", { stdio: "inherit" });
  console.log("[migrate] Migraciones al día.");
} catch (error) {
  // Si las migraciones fallan, el deploy debe fallar: es mucho peor publicar una
  // API que responde 500 en todas las consultas que no publicar nada.
  console.error("[migrate] Falló la aplicación de migraciones.");
  process.exit(1);
}
