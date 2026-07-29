/* eslint-disable */
/**
 * Pone la base al día durante el deploy, sin que nadie tenga que correr nada a mano.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────
 * vercel.json usa el formato viejo con "builds", y cuando ese campo está presente
 * Vercel IGNORA "buildCommand". O sea: el `prisma migrate deploy` que estaba
 * configurado ahí nunca se ejecutó y la base quedó sin las tablas y columnas
 * nuevas. El síntoma era error 500 en /listings y /favorites, porque Prisma
 * consultaba columnas que no existían. El paso "install" sí corre siempre, así
 * que la actualización va enganchada al postinstall.
 *
 * ── Por qué no alcanza con `prisma migrate deploy` ───────────────────────────
 * El historial de migraciones de este repo NO arranca de cero: la migración más
 * vieja ya hace `ALTER TABLE "Vehicle"`, así que nunca hubo una que creara las
 * tablas base. La base se creó con `prisma db push`. Sobre una base así,
 * `migrate deploy` falla (intenta aplicar migraciones antiguas sobre columnas que
 * ya existen) y encima deja una migración marcada como fallida.
 *
 * Por eso primero se mira el estado real y después se elige el camino:
 *
 *   · Con historial (_prisma_migrations con migraciones aplicadas)
 *       → `prisma migrate deploy`: aplica lo pendiente y lo anota. Si falla, se
 *         cae a db push.
 *   · Sin historial (la base se creó con db push, o está vacía)
 *       → `prisma db push`: lleva la base a lo que dice el schema sin mirar el
 *         historial. Va SIN --accept-data-loss a propósito: si un cambio
 *         implicara borrar datos, Prisma se niega y no lo toca.
 *
 * Al final se corre el backfill de la categoría de los autos ya publicados, que
 * es idempotente (solo toca filas en NULL).
 *
 * Si todo falla, el deploy NO se cae: se publica la API igual con un aviso bien
 * visible en el log. Un deploy en rojo dejaría en producción la versión vieja y
 * sin ninguno de los arreglos; así al menos anda todo lo que no depende de las
 * columnas nuevas, y `GET /health/db` dice exactamente qué falta.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isVercel = Boolean(process.env.VERCEL);
// `npm run db:migrate:prod` pasa --force para aplicarlas a mano desde la consola.
const forced =
  process.argv.includes("--force") || process.env.RUN_MIGRATIONS === "true";

if (!forced && !isVercel) {
  console.log("[migrate] Fuera del deploy: no se toca la base.");
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.log("[migrate] Sin DATABASE_URL: no se toca la base.");
  process.exit(0);
}

// DIRECT_URL es la conexión directa (sin pooler) que Prisma usa para migrar. El
// schema la declara, y si no está creada CUALQUIER comando de Prisma corta con
// "P1012 Environment variable not found: DIRECT_URL". Se completa con
// DATABASE_URL (la misma base) para no depender de una variable que nadie creó.
if (!process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  console.log("[migrate] DIRECT_URL no estaba definida: se usa DATABASE_URL.");
}

/**
 * Ruta al ejecutable de Prisma. Se resuelve a mano en vez de confiar en el PATH:
 * npm agrega node_modules/.bin cuando corre el postinstall, pero si alguien
 * ejecuta este archivo con `node scripts/deploy-migrate.js` no está, y el
 * comando fallaría con "prisma: not found".
 */
const PRISMA = (() => {
  const bin = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
  return fs.existsSync(bin) ? `"${bin}"` : "npx --no-install prisma";
})();

/** Corre un comando de Prisma. Devuelve true si terminó bien. */
function run(label, args) {
  console.log(`[migrate] ${label}`);
  try {
    execSync(`${PRISMA} ${args}`, { stdio: "inherit", env: process.env });
    return true;
  } catch {
    console.error(`[migrate] Falló: prisma ${args}`);
    return false;
  }
}

/**
 * ¿La base tiene historial de migraciones utilizable? Se consulta con el cliente
 * de Prisma, que el postinstall acaba de generar. Si no se puede saber, se asume
 * que no: db push es el camino seguro para esta base.
 */
async function hasMigrationHistory() {
  let prisma;
  try {
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    return Number(rows?.[0]?.applied ?? 0) > 0;
  } catch {
    // La tabla no existe (base creada con db push) o no se pudo consultar.
    return false;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  const withHistory = await hasMigrationHistory();
  let updated = false;

  if (withHistory) {
    console.log("[migrate] La base tiene historial de migraciones.");
    updated = run("Aplicando migraciones pendientes...", "migrate deploy");
    if (!updated) {
      console.warn(
        "[migrate] No se pudieron aplicar. Segundo intento: sincronizar el " +
          "schema sin mirar el historial.",
      );
    }
  } else {
    console.log(
      "[migrate] La base no tiene historial de migraciones (se creó con db " +
        "push): se sincroniza el schema directamente.",
    );
  }

  if (!updated) {
    updated = run(
      "Sincronizando schema (db push)...",
      "db push --skip-generate",
    );
  }

  if (!updated) {
    console.error(
      [
        "",
        "==================================================================",
        "[migrate] NO SE PUDO ACTUALIZAR LA BASE DE DATOS.",
        "",
        "La API se publica igual, pero lo que use las tablas o columnas",
        "nuevas va a fallar. Ver GET /health/db para saber qué falta, y los",
        "mensajes de arriba para el motivo (credenciales, red o drift).",
        "==================================================================",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }

  console.log("[migrate] Base al día.");

  // Categoría de los autos que ya estaban publicados. No es crítico: si falla,
  // esos autos quedan sin categoría y el resto de la app funciona igual.
  run(
    "Completando la categoría de los autos ya publicados...",
    `db execute --url "${process.env.DATABASE_URL}" --file prisma/backfill/vehicle-category.sql`,
  );

  process.exit(0);
}

main().catch((error) => {
  console.error("[migrate] Error inesperado:", error?.message ?? error);
  // Igual que arriba: no se corta el deploy por esto.
  process.exit(0);
});
