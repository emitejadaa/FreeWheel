import { ConfigService } from "@nestjs/config";

// JWT_SECRET must be provided explicitly. A hardcoded fallback would let the app
// boot with a publicly known signing key, allowing anyone to forge valid tokens.
export function getJwtSecret(configService: ConfigService): string {
  const secret = configService.get<string>("JWT_SECRET");

  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }

  return secret;
}
