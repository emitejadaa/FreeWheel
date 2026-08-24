import { execSync } from "child_process";
import { readdirSync } from "fs";
import { config } from "dotenv";
import { resolve } from "path";

/**
 * Runs once before the whole suite. Loads `.env.test` when present (local dev),
 * but also works when the variables are supplied by the environment (CI). It
 * refuses to run unless the database is explicitly marked disposable (the suite
 * truncates every table), then applies migrations so the schema is current.
 */
export default function globalSetup(): void {
  // Best-effort local load; in CI the variables come from the environment.
  config({ path: resolve(process.cwd(), ".env.test"), override: true });

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[e2e] DATABASE_URL is not set. Create .env.test from .env.test.example " +
        "(pointing at a disposable Neon TEST branch) or set it in the environment.",
    );
  }

  // Hard safety gate: the suite wipes every table, so it must never run against a
  // database that isn't an explicit throwaway. The dev/prod `.env` never sets this.
  if (process.env.ALLOW_DB_RESET !== "true") {
    throw new Error(
      "[e2e] Refusing to run: set ALLOW_DB_RESET=true to confirm DATABASE_URL " +
        "points at a disposable TEST database (the suite truncates all tables).",
    );
  }

  // The throwaway test DB is materialized directly from `schema.prisma` with
  // `db push` (reset each run) instead of `migrate deploy`. The committed
  // migration history has no initial baseline (User/Vehicle/Listing predate it
  // from an original `db push`), so `migrate deploy` cannot build a database
  // from scratch. `db push` mirrors the current schema exactly, which is what an
  // ephemeral E2E database needs; production keeps using the migration chain.
  // prisma/premigrate: los arreglos que `db push` no sabe hacer solo, y las
  // garantías que `schema.prisma` no sabe expresar (que el email se guarde
  // siempre en minúsculas, y que no haya dos cuentas con la misma dirección
  // aunque estén escritas distinto). Sin esto la base de los tests no tendría
  // las mismas reglas que la de producción, que es justo lo que hay que probar.
  //
  // Corre ANTES y DESPUÉS del push, y por la misma razón en cada caso:
  //   · antes, porque hay arreglos que tienen que pasar para que el push pueda
  //     avanzar (el índice único de "phone" no se puede crear si quedaron dos
  //     filas con el mismo número), y es el orden del deploy real;
  //   · después, porque sobre una base recién creada —el caso normal acá— antes
  //     del push no existe ninguna tabla y no hay dónde poner las garantías.
  //
  // Los fallos se ignoran, igual que en scripts/deploy-migrate.js: los archivos
  // viejos son backfills de datos que ya no existen y sobre una base vacía
  // cortan. Que las garantías hayan quedado puestas de verdad no se confía a
  // este bloque: lo comprueba la suite (ver users.e2e-spec.ts).
  const premigrate = () => {
    for (const file of readdirSync(resolve(process.cwd(), "prisma/premigrate"))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      try {
        execSync(
          `npx prisma db execute --url "${process.env.DATABASE_URL}" ` +
            `--file prisma/premigrate/${file}`,
          { stdio: "ignore", env: process.env },
        );
      } catch {
        // Ver arriba: sobre una base vacía es lo esperable.
      }
    }
  };

  premigrate();
  execSync("npx prisma db push --skip-generate", {
    stdio: "inherit",
    env: process.env,
  });
  premigrate();
}
