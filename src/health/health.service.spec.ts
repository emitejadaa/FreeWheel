import { PrismaService } from "../prisma/prisma.service";
import { HealthService } from "./health.service";

type Row = { table_name: string; column_name: string };

/**
 * `$queryRaw` se usa dos veces: primero para las columnas existentes y después
 * para el historial de migraciones. El mock responde en ese orden.
 */
function makePrisma(columns: Row[], lastMigration?: string) {
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce(columns)
    .mockResolvedValueOnce(
      lastMigration ? [{ migration_name: lastMigration }] : [],
    );

  return {
    prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
    queryRaw,
  };
}

const ALL_PRESENT: Row[] = [
  { table_name: "Favorite", column_name: "id" },
  { table_name: "Vehicle", column_name: "category" },
  { table_name: "UserVerification", column_name: "documentNumber" },
  { table_name: "UserVerification", column_name: "licenseExpiresAt" },
];

describe("HealthService.checkDatabase", () => {
  it("reports the schema as up to date when everything exists", async () => {
    const { prisma } = makePrisma(ALL_PRESENT, "20260728180000_add_data");
    const result = await new HealthService(prisma).checkDatabase();

    expect(result.database).toBe("ok");
    expect(result.schemaUpToDate).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.lastMigration).toBe("20260728180000_add_data");
    expect(result.hint).toBeNull();
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it("names what is missing when the migrations did not run", async () => {
    // La base vieja: sin tabla Favorite y sin Vehicle.category.
    const { prisma } = makePrisma([
      { table_name: "UserVerification", column_name: "documentNumber" },
      { table_name: "UserVerification", column_name: "licenseExpiresAt" },
    ]);
    const result = await new HealthService(prisma).checkDatabase();

    expect(result.database).toBe("ok");
    expect(result.schemaUpToDate).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.missing.join(" ")).toContain("Favorite");
    expect(result.missing.join(" ")).toContain("Vehicle.category");
    expect(result.hint).toContain("migraciones");
  });

  it("reports the database as unreachable instead of throwing", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as PrismaService;

    const result = await new HealthService(prisma).checkDatabase();

    expect(result.database).toBe("unreachable");
    expect(result.schemaUpToDate).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
