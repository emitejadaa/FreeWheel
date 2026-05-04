import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EndpointCheck {
  method: string;
  path: string;
  expectedStatus: number;
  critical: boolean;
  description: string;
}

export interface CheckResult extends EndpointCheck {
  url: string;
  receivedStatus: number | null;
  responseTimeMs: number;
  ok: boolean;
  skipped: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export const publicEndpointChecks: EndpointCheck[] = [
  {
    method: 'GET',
    path: '/',
    expectedStatus: 200,
    critical: true,
    description: 'Root application endpoint',
  },
  {
    method: 'GET',
    path: '/listings',
    expectedStatus: 200,
    critical: true,
    description: 'Public active listings endpoint',
  },
  {
    method: 'GET',
    path: '/health',
    expectedStatus: 200,
    critical: false,
    description: 'Optional health endpoint when implemented',
  },
];

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function runEndpointChecks(
  baseUrl: string,
  checks: EndpointCheck[] = publicEndpointChecks,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const url = resolveUrl(baseUrl, check.path);
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: check.method,
        signal: controller.signal,
      });
      const responseTimeMs = Math.round(performance.now() - startedAt);
      const optionalMissingHealth =
        check.path === '/health' && response.status === 404 && !check.critical;

      results.push({
        ...check,
        url,
        receivedStatus: response.status,
        responseTimeMs,
        ok: optionalMissingHealth || response.status === check.expectedStatus,
        skipped: optionalMissingHealth,
        error: optionalMissingHealth ? 'Optional health endpoint is not implemented.' : undefined,
      });
    } catch (error) {
      results.push({
        ...check,
        url,
        receivedStatus: null,
        responseTimeMs: Math.round(performance.now() - startedAt),
        ok: false,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl && normalizeBaseUrl(frontendUrl) !== normalizeBaseUrl(baseUrl)) {
    results.push(await runCorsPreflightCheck(baseUrl, frontendUrl));
  }

  return results;
}

async function runCorsPreflightCheck(baseUrl: string, frontendUrl: string): Promise<CheckResult> {
  const path = '/auth/login';
  const url = resolveUrl(baseUrl, path);
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'OPTIONS',
      signal: controller.signal,
      headers: {
        Origin: normalizeBaseUrl(frontendUrl),
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const allowOrigin = response.headers.get('access-control-allow-origin');
    const ok = response.status === 204 && allowOrigin === normalizeBaseUrl(frontendUrl);

    return {
      method: 'OPTIONS',
      path,
      expectedStatus: 204,
      critical: true,
      description: `CORS preflight from ${normalizeBaseUrl(frontendUrl)}`,
      url,
      receivedStatus: response.status,
      responseTimeMs,
      ok,
      skipped: false,
      error: ok
        ? undefined
        : `Expected access-control-allow-origin: ${normalizeBaseUrl(frontendUrl)}, received: ${
            allowOrigin ?? 'missing'
          }`,
    };
  } catch (error) {
    return {
      method: 'OPTIONS',
      path,
      expectedStatus: 204,
      critical: true,
      description: `CORS preflight from ${normalizeBaseUrl(frontendUrl)}`,
      url,
      receivedStatus: null,
      responseTimeMs: Math.round(performance.now() - startedAt),
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function hasCriticalFailures(results: CheckResult[]): boolean {
  return results.some((result) => result.critical && !result.ok);
}

export function printReport(baseUrl: string, results: CheckResult[]): void {
  console.log(`Base URL: ${normalizeBaseUrl(baseUrl)}`);
  console.log('');
  console.log('Method  Endpoint       Expected  Received  Time(ms)  Result');

  for (const result of results) {
    const received = result.receivedStatus === null ? 'ERROR' : String(result.receivedStatus);
    const status = result.skipped ? 'SKIP' : result.ok ? 'OK' : 'FAIL';
    console.log(
      `${result.method.padEnd(7)} ${result.path.padEnd(14)} ${String(
        result.expectedStatus,
      ).padEnd(9)} ${received.padEnd(9)} ${String(result.responseTimeMs).padEnd(9)} ${status}`,
    );

    if (result.error) {
      console.log(`  ${result.error}`);
    }
  }
}

export function printDiscoveredEndpoints(): void {
  const endpoints = discoverNestEndpoints();

  if (endpoints.length === 0) {
    console.log('No NestJS controllers were detected for endpoint discovery.');
    return;
  }

  console.log('');
  console.log('Discovered controller routes:');
  for (const endpoint of endpoints) {
    console.log(`- ${endpoint}`);
  }
  console.log('');
  console.log(
    'Authenticated or data-dependent routes are documented only; token and IDs are not invented by this checker.',
  );
}

function discoverNestEndpoints(): string[] {
  const srcDir = join(process.cwd(), 'src');

  if (!existsSync(srcDir)) {
    return [];
  }

  const controllerFiles = listControllerFiles(srcDir);
  const endpoints: string[] = [];

  for (const file of controllerFiles) {
    const content = readFileSync(file, 'utf8');
    const controllerMatch = content.match(/@Controller\((?:'([^']*)'|"([^"]*)")?\)/);
    const prefix = controllerMatch?.[1] ?? controllerMatch?.[2] ?? '';
    const routeRegex = /@(Get|Post|Patch|Delete|Put)\((?:'([^']*)'|"([^"]*)")?\)/g;
    let match: RegExpExecArray | null;

    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2] ?? match[3] ?? '';
      endpoints.push(`${method} ${joinRoute(prefix, routePath)}`);
    }
  }

  return endpoints.sort();
}

function listControllerFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...listControllerFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function joinRoute(prefix: string, routePath: string): string {
  const parts = [prefix, routePath].filter(Boolean).map((part) => part.replace(/^\/+|\/+$/g, ''));
  return `/${parts.join('/')}`;
}
