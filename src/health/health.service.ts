import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Cada cosa que el código nuevo necesita que exista en la base, con el nombre
 * de la funcionalidad que se rompe si falta. Sirve para poder decir "falta la
 * tabla de favoritos" en vez de "error 500".
 */
const REQUIRED_SCHEMA: {
  feature: string;
  table: string;
  column?: string;
}[] = [
  { feature: "favoritos", table: "Favorite" },
  { feature: "filtro por categoría", table: "Vehicle", column: "category" },
  {
    feature: "datos leídos del DNI",
    table: "UserVerification",
    column: "documentNumber",
  },
  {
    feature: "vencimiento de la licencia",
    table: "UserVerification",
    column: "licenseExpiresAt",
  },
];

export interface DatabaseHealth {
  /** "ok" si se pudo consultar la base, "unreachable" si no responde. */
  database: "ok" | "unreachable";
  /** true cuando están todas las tablas y columnas que el código usa. */
  schemaUpToDate: boolean;
  /** Detalle por funcionalidad: true = la base la soporta. */
  checks: Record<string, boolean>;
  /** Lo que falta, listo para leer. Vacío cuando todo está al día. */
  missing: string[];
  /** Última migración anotada en el historial de Prisma, si existe. */
  lastMigration: string | null;
  /** Qué hacer si algo falta. */
  hint: string | null;
  error?: string;
}

/**
 * Diagnóstico de la base pensado para no depender de tener acceso al panel del
 * proveedor: dice si el deploy alcanzó a aplicar las migraciones y, si no, qué
 * quedó afuera. Es solo lectura sobre el catálogo de Postgres.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<DatabaseHealth> {
    try {
      const present = await this.presentColumns();
      const checks: Record<string, boolean> = {};
      const missing: string[] = [];

      for (const item of REQUIRED_SCHEMA) {
        const key = item.column
          ? `${item.table}.${item.column}`
          : `${item.table}`;
        const ok = item.column
          ? present.get(item.table)?.has(item.column) === true
          : present.has(item.table);

        checks[`${key} (${item.feature})`] = ok;
        if (!ok) missing.push(`${key} — ${item.feature}`);
      }

      return {
        database: "ok",
        schemaUpToDate: missing.length === 0,
        checks,
        missing,
        lastMigration: await this.lastMigration(),
        hint:
          missing.length === 0
            ? null
            : "Las migraciones no se aplicaron. Se reintentan solas en el " +
              "próximo deploy (postinstall); el motivo queda en el log del build.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo consultar la base: ${message}`);

      return {
        database: "unreachable",
        schemaUpToDate: false,
        checks: {},
        missing: REQUIRED_SCHEMA.map((item) => item.feature),
        lastMigration: null,
        hint: "La base no responde: revisar DATABASE_URL en las variables de entorno.",
        error: message,
      };
    }
  }

  /** Tablas y columnas que existen hoy, en una sola consulta. */
  private async presentColumns(): Promise<Map<string, Set<string>>> {
    const tables = REQUIRED_SCHEMA.map((item) => item.table);
    const rows = await this.prisma.$queryRaw<
      { table_name: string; column_name: string }[]
    >`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY(${tables})
    `;

    const present = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = present.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      present.set(row.table_name, columns);
    }

    return present;
  }

  /**
   * Última migración aplicada. Si la tabla de historial no existe, la base se
   * creó sin migraciones: no es un error, solo no hay historial que mostrar.
   */
  private async lastMigration(): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;

      return rows[0]?.migration_name ?? null;
    } catch {
      return null;
    }
  }
}
