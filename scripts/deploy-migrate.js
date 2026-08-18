/* eslint-disable */
/**
 * Pone la base al día durante el deploy, sin que nadie tenga que correr nada a mano.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────
 * vercel.json usaba el formato viejo con "builds", y cuando ese campo está
 * presente Vercel IGNORA "buildCommand". O sea: el `prisma migrate deploy` que
 * estaba configurado ahí nunca se ejecutó y la base quedó sin las tablas y
 * columnas nuevas. El síntoma era error 500 en /listings y /favorites, porque
 * Prisma consultaba columnas que no existían. El paso "install" sí corre
 * siempre, así que la actualización va enganchada al postinstall.
 *
 * vercel.json ya no usa "builds", así que hoy el buildCommand sí se ejecuta;
 * por eso quedó en `npm run build` y no repite las migraciones. La base la
 * sigue poniendo al día este archivo, que corre antes y sabe elegir el camino.
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
 * ── El único aviso que sí se acepta ──────────────────────────────────────────
 * Prisma mete en la misma bolsa de "puede haber pérdida de datos" a agregar una
 * constraint única, y no es lo mismo: agregarla no borra nada, o entra o falla
 * entera. Con dni y cuil únicos en el schema, db push cortaba pidiendo
 * --accept-data-loss y la base se quedaba sin la unicidad que impide que un
 * mismo documento verifique dos cuentas.
 *
 * Así que se lee la salida y se reintenta con --accept-data-loss SOLO si todos
 * los avisos son de constraints únicas. Alcanza con que aparezca uno que borra
 * (una columna, una tabla, un tipo que se recrea) para no reintentar: eso hay
 * que resolverlo a mano, no en un deploy automático.
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

/**
 * Corre un comando de Prisma. Devuelve `{ ok, output }`: la salida se captura
 * para poder mirarla (ver `soloAvisosDeConstraintUnica`) y se reimprime tal
 * cual, así el log del deploy sigue mostrando lo mismo que antes.
 */
function run(label, args) {
  console.log(`[migrate] ${label}`);
  try {
    const stdout = execSync(`${PRISMA} ${args}`, {
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (stdout) process.stdout.write(stdout);
    return { ok: true, output: stdout || "" };
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}`;
    if (output) process.stdout.write(output);
    console.error(`[migrate] Falló: prisma ${args}`);
    return { ok: false, output };
  }
}

/**
 * Prisma lista los avisos como viñetas ("  • ..."). Devuelve true solo si el
 * comando cortó pidiendo --accept-data-loss, hubo al menos un aviso, y TODOS
 * son "se va a agregar una constraint única" —el único que no borra nada—.
 *
 * Si el formato de la salida cambiara y no se reconociera ninguna viñeta, da
 * false: no reintentar deja la base sin actualizar, que es el lado seguro.
 */
function soloAvisosDeConstraintUnica(output) {
  if (!output.includes("--accept-data-loss")) return false;

  const avisos = output
    .split("\n")
    .map((linea) => linea.trim())
    .filter((linea) => linea.startsWith("•"));

  return (
    avisos.length > 0 &&
    avisos.every((aviso) =>
      /^•\s*A unique constraint covering the columns .* will be added/i.test(
        aviso,
      ),
    )
  );
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

/**
 * Arreglos estructurales que `db push` no sabe hacer solo, corridos ANTES del
 * push.
 *
 * El caso que los trajo: para llegar al schema nuevo había que borrar tres
 * columnas de Listing, y una publicación las tenía cargadas. `db push` se negó
 * —bien negado— y la base quedó sin la columna nueva mientras la API que la
 * consulta ya estaba publicada: 500 en /listings.
 *
 * Un `--accept-data-loss` acá habría borrado esos datos sin que nadie los mire.
 * Lo que corresponde es mover el dato a donde va y recién después dejar que el
 * push encuentre la columna vacía y la saque sin drama.
 *
 * Los archivos de prisma/premigrate corren en orden de nombre y TIENEN que
 * poder correr en todos los deploys: preguntan antes de tocar nada.
 */
function preMigrate() {
  const dir = path.join(__dirname, "..", "prisma", "premigrate");
  if (!fs.existsSync(dir)) return;

  const archivos = fs
    .readdirSync(dir)
    .filter((nombre) => nombre.endsWith(".sql"))
    .sort();

  for (const archivo of archivos) {
    run(
      `Preparando la base: ${archivo}`,
      `db execute --url "${process.env.DATABASE_URL}" ` +
        `--file prisma/premigrate/${archivo}`,
    );
  }
}

async function main() {
  // Va antes de todo: si esto no corre, el push que viene abajo se planta.
  preMigrate();

  const withHistory = await hasMigrationHistory();
  let updated = false;

  if (withHistory) {
    console.log("[migrate] La base tiene historial de migraciones.");
    updated = run("Aplicando migraciones pendientes...", "migrate deploy").ok;
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
    const push = run(
      "Sincronizando schema (db push)...",
      "db push --skip-generate",
    );
    updated = push.ok;

    if (!updated && soloAvisosDeConstraintUnica(push.output)) {
      console.warn(
        "[migrate] El único cambio marcado como riesgoso es agregar una " +
          "constraint única, que no borra datos: se reintenta aceptándolo. " +
          "Si hubiera duplicados, el comando falla y no toca nada.",
      );
      updated = run(
        "Reintentando (db push --accept-data-loss)...",
        "db push --skip-generate --accept-data-loss",
      ).ok;
    }
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
