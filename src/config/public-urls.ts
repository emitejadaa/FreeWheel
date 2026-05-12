import { ConfigService } from "@nestjs/config";

const LOCAL_API_BASE_URL = "http://localhost:3000";
const LOCAL_FRONTEND_URL = "http://localhost:5173";

export function getPublicApiBaseUrl(configService: ConfigService): string {
  const configuredApiUrl = configService.get<string>("API_BASE_URL");
  if (configuredApiUrl) {
    return normalizeBaseUrl(configuredApiUrl);
  }

  const vercelUrl = configService.get<string>("VERCEL_URL");
  if (vercelUrl) {
    return normalizeBaseUrl(`https://${vercelUrl}`);
  }

  return LOCAL_API_BASE_URL;
}

export function getFrontendUrl(configService: ConfigService): string {
  return normalizeBaseUrl(
    configService.get<string>("FRONTEND_URL") ?? LOCAL_FRONTEND_URL,
  );
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
