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

// CORS intentionally reflects any incoming origin (origin: true) to support the
// main frontend, Vercel preview deployments, and local clients without a
// maintained whitelist. Tighten to an explicit allowlist when origins stabilize.
export function createCorsOptions(): CorsOptions {
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
