import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

const ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

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
    methods: ALLOWED_METHODS,
    allowedHeaders: undefined,
    exposedHeaders: ["*"],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, "");
}
