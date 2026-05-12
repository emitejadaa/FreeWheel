import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

export function parseCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredOrigins = [env.FRONTEND_URL, env.CORS_ORIGINS]
    .filter(Boolean)
    .flatMap((value) => value!.split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  if (env.NODE_ENV !== "production") {
    configuredOrigins.push("http://localhost:3000", "http://localhost:5173");
  }

  return Array.from(new Set(configuredOrigins));
}

export function createCorsOptions(corsOrigins: string[]): CorsOptions {
  void corsOrigins;

  return {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    optionsSuccessStatus: 204,
  };
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, "");
}
