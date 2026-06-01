import { ConfigService } from "@nestjs/config";

const DEFAULT_JWT_SECRET = "freewheel-secret-key-change-in-production";

// SECURITY DEBT: falls back to a known default when JWT_SECRET is unset, retained
// because the live app currently relies on it. Anyone who knows this default can
// forge tokens, so set JWT_SECRET in every environment and then switch this to
// fail-fast (throw when the variable is missing).
export function getJwtSecret(configService: ConfigService): string {
  return configService.get<string>("JWT_SECRET") ?? DEFAULT_JWT_SECRET;
}
