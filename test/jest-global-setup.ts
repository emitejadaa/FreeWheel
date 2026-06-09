import { execSync } from "child_process";
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

  // Ensure the test database schema matches the current migrations.
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });
}
