import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OPTIONS';
type ResultStatus = 'PASS' | 'FAIL' | 'SKIP';

interface DiscoveredEndpoint {
  method: HttpMethod;
  path: string;
}

interface TestResult {
  name: string;
  method?: HttpMethod;
  path?: string;
  status: ResultStatus;
  expected?: string;
  received?: string;
  durationMs?: number;
  detail?: string;
}

interface HttpResult {
  status: number;
  ok: boolean;
  headers: Headers;
  body: unknown;
  text: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.FUNCTIONAL_TEST_TIMEOUT_MS ?? 10000);

async function main() {
  const targetUrl = process.env.TARGET_URL ?? process.env.FRONTEND_URL ?? process.env.API_BASE_URL;
  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.TARGET_URL;
  const frontendUrl = process.env.FRONTEND_URL ?? process.env.TARGET_URL;

  if (!targetUrl || !apiBaseUrl) {
    console.error('TARGET_URL or API_BASE_URL is required.');
    console.error('Examples:');
    console.error('  TARGET_URL=http://localhost:3000 npm run test:functional');
    console.error('  FRONTEND_URL=https://front.example.com API_BASE_URL=https://api.example.com npm run test:functional');
    process.exitCode = 1;
    return;
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrl);
  const endpoints = discoverNestEndpoints();
  const endpointSet = new Set(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`));
  const results: TestResult[] = [];

  console.log('Functional deployment test');
  console.log(`Target URL: ${normalizeBaseUrl(targetUrl)}`);
  console.log(`API base URL: ${baseUrl}`);
  if (frontendUrl && normalizeBaseUrl(frontendUrl) !== baseUrl) {
    console.log(`Frontend URL: ${normalizeBaseUrl(frontendUrl)}`);
  }
  console.log('');

  printDetectedProjectShape(endpoints);

  await probeOpenApi(baseUrl, results);
  await probeFrontend(frontendUrl, baseUrl, results);
  await probeCors(frontendUrl, baseUrl, results);

  await runIfDetected(results, endpointSet, 'GET /', 'Root endpoint', async () => {
    const response = await request(baseUrl, 'GET', '/');
    expectStatus(response, [200]);
  });

  await runIfDetected(results, endpointSet, 'GET /listings', 'Public active listings list', async () => {
    const response = await request(baseUrl, 'GET', '/listings');
    expectStatus(response, [200]);
    expectArray(response.body, 'GET /listings should return an array.');
  });

  await runOptionalHealth(baseUrl, results);

  const auth = await authenticate(baseUrl, endpointSet, results);

  if (!auth?.accessToken) {
    results.push({
      name: 'Authenticated functional flow',
      status: 'SKIP',
      detail: 'No valid access token is available. Protected endpoint checks were not executed.',
    });
    printReport(results);
    process.exitCode = hasFailures(results) ? 1 : 0;
    return;
  }

  await runProtectedFlow(baseUrl, endpointSet, auth.accessToken, results);

  printReport(results);
  process.exitCode = hasFailures(results) ? 1 : 0;
}

function printDetectedProjectShape(endpoints: DiscoveredEndpoint[]): void {
  const hasBackend = existsSync(join(process.cwd(), 'src')) && endpoints.length > 0;
  const frontendMarkers = ['vite.config.ts', 'next.config.js', 'next.config.ts', 'src/App.tsx', 'app/page.tsx'];
  const hasFrontend = frontendMarkers.some((marker) => existsSync(join(process.cwd(), marker)));

  console.log('Detected local project shape:');
  console.log(`- Backend: ${hasBackend ? 'yes, NestJS controllers found' : 'not detected'}`);
  console.log(`- Frontend: ${hasFrontend ? 'yes, frontend markers found' : 'not detected in this repo'}`);
  console.log('');

  if (endpoints.length > 0) {
    console.log('Detected backend endpoints from controllers:');
    for (const endpoint of endpoints) {
      console.log(`- ${endpoint.method} ${endpoint.path}`);
    }
    console.log('');
  }
}

async function probeOpenApi(baseUrl: string, results: TestResult[]): Promise<void> {
  const candidates = ['/api-json', '/openapi.json', '/swagger.json'];

  for (const candidate of candidates) {
    const response = await request(baseUrl, 'GET', candidate, undefined, { optional: true });
    if (response.status === 200 && response.body && typeof response.body === 'object') {
      results.push({
        name: 'OpenAPI/Swagger discovery',
        method: 'GET',
        path: candidate,
        status: 'PASS',
        expected: '200',
        received: String(response.status),
        durationMs: response.durationMs,
        detail: 'OpenAPI document detected. Local controller discovery is still used to avoid testing undocumented future features.',
      });
      return;
    }
  }

  results.push({
    name: 'OpenAPI/Swagger discovery',
    status: 'SKIP',
    detail: 'No OpenAPI/Swagger document detected at /api-json, /openapi.json or /swagger.json.',
  });
}

async function probeFrontend(
  frontendUrl: string | undefined,
  baseUrl: string,
  results: TestResult[],
): Promise<void> {
  if (!frontendUrl || normalizeBaseUrl(frontendUrl) === baseUrl) {
    return;
  }

  await record(results, 'Frontend host responds', 'GET', '/', async () => {
    const response = await request(normalizeBaseUrl(frontendUrl), 'GET', '/');
    expectStatus(response, [200]);
  });
}

async function probeCors(
  frontendUrl: string | undefined,
  baseUrl: string,
  results: TestResult[],
): Promise<void> {
  if (!frontendUrl || normalizeBaseUrl(frontendUrl) === baseUrl) {
    results.push({
      name: 'CORS preflight',
      status: 'SKIP',
      detail: 'Frontend and API are not configured as separate origins.',
    });
    return;
  }

  await record(results, 'CORS preflight from frontend origin', 'OPTIONS', '/auth/login', async () => {
    const response = await request(baseUrl, 'OPTIONS', '/auth/login', undefined, {
      headers: {
        Origin: normalizeBaseUrl(frontendUrl),
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });

    const allowOrigin = response.headers.get('access-control-allow-origin');
    if (!allowOrigin) {
      throw new Error('Missing access-control-allow-origin header. Browser requests from the frontend may be blocked by CORS.');
    }
  });
}

async function authenticate(
  baseUrl: string,
  endpointSet: Set<string>,
  results: TestResult[],
): Promise<{ accessToken: string } | null> {
  const configuredEmail = process.env.TEST_EMAIL;
  const configuredPassword = process.env.TEST_PASSWORD;
  const password = configuredPassword ?? 'TestPassword123!';
  const unique = Date.now();
  const email = configuredEmail ?? `e2e-test-${unique}@example.com`;

  if (configuredEmail && configuredPassword && endpointSet.has('POST /auth/login')) {
    let token: string | null = null;
    await record(results, 'Login with provided test credentials', 'POST', '/auth/login', async () => {
      const response = await request(baseUrl, 'POST', '/auth/login', { email, password });
      expectStatus(response, [200, 201]);
      token = extractToken(response.body);
    });
    return token ? { accessToken: token } : null;
  }

  if (!endpointSet.has('POST /auth/register')) {
    results.push({
      name: 'Register generated test user',
      status: 'SKIP',
      detail: 'POST /auth/register is not implemented.',
    });
    return null;
  }

  let accessToken: string | null = null;
  await record(results, 'Register generated test user', 'POST', '/auth/register', async () => {
    const response = await request(baseUrl, 'POST', '/auth/register', {
      email,
      password,
      firstName: 'E2E',
      lastName: `Test ${unique}`,
    });
    expectStatus(response, [200, 201]);
    accessToken = extractToken(response.body);
  });

  if (endpointSet.has('POST /auth/login')) {
    await record(results, 'Login generated test user', 'POST', '/auth/login', async () => {
      const response = await request(baseUrl, 'POST', '/auth/login', { email, password });
      expectStatus(response, [200, 201]);
      accessToken = extractToken(response.body);
    });
  }

  return accessToken ? { accessToken } : null;
}

async function runProtectedFlow(
  baseUrl: string,
  endpointSet: Set<string>,
  accessToken: string,
  results: TestResult[],
): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const unique = Date.now();

  await runIfDetected(results, endpointSet, 'GET /users/me', 'Read authenticated user profile', async () => {
    const response = await request(baseUrl, 'GET', '/users/me', undefined, { headers });
    expectStatus(response, [200]);
    expectObjectWithId(response.body, 'GET /users/me should return the authenticated user.');
  });

  await runIfDetected(results, endpointSet, 'PATCH /users/me', 'Update authenticated user profile', async () => {
    const response = await request(
      baseUrl,
      'PATCH',
      '/users/me',
      { firstName: 'E2E Updated', phone: '+5491100000000' },
      { headers },
    );
    expectStatus(response, [200]);
  });

  let vehicleId: string | null = null;
  await runIfDetected(results, endpointSet, 'POST /vehicles', 'Create test vehicle', async () => {
    const response = await request(
      baseUrl,
      'POST',
      '/vehicles',
      {
        brand: 'E2E Test Brand',
        model: `Functional ${unique}`,
        year: 2020,
        plate: `E2E${String(unique).slice(-4)}`,
        color: 'Test Gray',
        seats: 5,
        transmission: 'AUTOMATIC',
        fuelType: 'GASOLINE',
      },
      { headers },
    );
    expectStatus(response, [200, 201]);
    vehicleId = extractId(response.body);
  });

  await runIfDetected(results, endpointSet, 'GET /vehicles/me', 'List authenticated user vehicles', async () => {
    const response = await request(baseUrl, 'GET', '/vehicles/me', undefined, { headers });
    expectStatus(response, [200]);
    expectArray(response.body, 'GET /vehicles/me should return an array.');
  });

  if (vehicleId && endpointSet.has('GET /vehicles/:id')) {
    await record(results, 'Read created vehicle by id', 'GET', '/vehicles/:id', async () => {
      const response = await request(baseUrl, 'GET', `/vehicles/${vehicleId}`);
      expectStatus(response, [200]);
      expectObjectWithId(response.body, 'GET /vehicles/:id should return a vehicle.');
    });
  }

  if (vehicleId && endpointSet.has('PATCH /vehicles/:id')) {
    await record(results, 'Update created vehicle', 'PATCH', '/vehicles/:id', async () => {
      const response = await request(
        baseUrl,
        'PATCH',
        `/vehicles/${vehicleId}`,
        { color: 'E2E Black' },
        { headers },
      );
      expectStatus(response, [200]);
    });
  }

  await runVehicleDeleteCheck(baseUrl, endpointSet, headers, results, unique);
  await runListingFlow(baseUrl, endpointSet, headers, results, vehicleId);
}

async function runVehicleDeleteCheck(
  baseUrl: string,
  endpointSet: Set<string>,
  headers: Record<string, string>,
  results: TestResult[],
  unique: number,
): Promise<void> {
  if (!endpointSet.has('POST /vehicles') || !endpointSet.has('DELETE /vehicles/:id')) {
    results.push({
      name: 'Delete vehicle',
      status: 'SKIP',
      detail: 'Vehicle create/delete endpoints are not both implemented.',
    });
    return;
  }

  let deleteVehicleId: string | null = null;
  await record(results, 'Create disposable vehicle for delete test', 'POST', '/vehicles', async () => {
    const response = await request(
      baseUrl,
      'POST',
      '/vehicles',
      {
        brand: 'E2E Delete Brand',
        model: `Delete ${unique}`,
        year: 2021,
      },
      { headers },
    );
    expectStatus(response, [200, 201]);
    deleteVehicleId = extractId(response.body);
  });

  if (!deleteVehicleId) {
    return;
  }

  await record(results, 'Delete disposable vehicle', 'DELETE', '/vehicles/:id', async () => {
    const response = await request(baseUrl, 'DELETE', `/vehicles/${deleteVehicleId}`, undefined, { headers });
    expectStatus(response, [200]);
  });
}

async function runListingFlow(
  baseUrl: string,
  endpointSet: Set<string>,
  headers: Record<string, string>,
  results: TestResult[],
  vehicleId: string | null,
): Promise<void> {
  if (!vehicleId || !endpointSet.has('POST /listings')) {
    results.push({
      name: 'Create listing',
      status: 'SKIP',
      detail: 'No created vehicle is available or POST /listings is not implemented.',
    });
    return;
  }

  let listingId: string | null = null;
  await record(results, 'Create active test listing', 'POST', '/listings', async () => {
    const response = await request(
      baseUrl,
      'POST',
      '/listings',
      {
        vehicleId,
        title: 'e2e-test-functional-listing',
        description: 'Functional test listing generated by automation.',
        pricePerDay: 45000,
        locationText: 'E2E Test Location',
        status: 'ACTIVE',
      },
      { headers },
    );
    expectStatus(response, [200, 201]);
    listingId = extractId(response.body);
  });

  await runIfDetected(results, endpointSet, 'GET /listings/me', 'List authenticated user listings', async () => {
    const response = await request(baseUrl, 'GET', '/listings/me', undefined, { headers });
    expectStatus(response, [200]);
    expectArray(response.body, 'GET /listings/me should return an array.');
  });

  if (listingId && endpointSet.has('GET /listings/:id')) {
    await record(results, 'Read active listing by id', 'GET', '/listings/:id', async () => {
      const response = await request(baseUrl, 'GET', `/listings/${listingId}`);
      expectStatus(response, [200]);
      expectObjectWithId(response.body, 'GET /listings/:id should return a listing.');
    });
  }

  if (listingId && endpointSet.has('PATCH /listings/:id')) {
    await record(results, 'Update created listing', 'PATCH', '/listings/:id', async () => {
      const response = await request(
        baseUrl,
        'PATCH',
        `/listings/${listingId}`,
        { title: 'e2e-test-functional-listing-updated', pricePerDay: 50000 },
        { headers },
      );
      expectStatus(response, [200]);
    });
  }

  if (listingId && endpointSet.has('DELETE /listings/:id')) {
    await record(results, 'Delete created listing', 'DELETE', '/listings/:id', async () => {
      const response = await request(baseUrl, 'DELETE', `/listings/${listingId}`, undefined, { headers });
      expectStatus(response, [200]);
    });
  }
}

async function runOptionalHealth(baseUrl: string, results: TestResult[]): Promise<void> {
  const response = await request(baseUrl, 'GET', '/health', undefined, { optional: true });
  if (response.status === 404) {
    results.push({
      name: 'Health check',
      method: 'GET',
      path: '/health',
      status: 'SKIP',
      received: '404',
      durationMs: response.durationMs,
      detail: 'Health endpoint is not implemented.',
    });
    return;
  }

  results.push({
    name: 'Health check',
    method: 'GET',
    path: '/health',
    status: response.status === 200 ? 'PASS' : 'FAIL',
    expected: '200 or 404 skip',
    received: String(response.status),
    durationMs: response.durationMs,
    detail: response.status === 200 ? undefined : classifyHttpError(response),
  });
}

async function runIfDetected(
  results: TestResult[],
  endpointSet: Set<string>,
  endpoint: string,
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const [method, path] = endpoint.split(' ') as [HttpMethod, string];
  if (!endpointSet.has(endpoint)) {
    results.push({
      name,
      method,
      path,
      status: 'SKIP',
      detail: `${endpoint} is not implemented in local controllers.`,
    });
    return;
  }

  await record(results, name, method, path, fn);
}

async function record(
  results: TestResult[],
  name: string,
  method: HttpMethod,
  path: string,
  fn: () => Promise<void>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    await fn();
    results.push({
      name,
      method,
      path,
      status: 'PASS',
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    results.push({
      name,
      method,
      path,
      status: 'FAIL',
      durationMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function request(
  baseUrl: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
  options?: { headers?: Record<string, string>; optional?: boolean },
): Promise<HttpResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(resolveUrl(baseUrl, path), {
      method,
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options?.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: parseBody(text),
      text,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    if (options?.optional) {
      return {
        status: 0,
        ok: false,
        headers: new Headers(),
        body: null,
        text: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
    throw new Error(`Connection error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function expectStatus(response: HttpResult, expected: number[]): void {
  if (!expected.includes(response.status)) {
    throw new Error(classifyHttpError(response, expected));
  }
}

function expectArray(body: unknown, message: string): void {
  if (!Array.isArray(body)) {
    throw new Error(message);
  }
}

function expectObjectWithId(body: unknown, message: string): void {
  if (!body || typeof body !== 'object' || !('id' in body)) {
    throw new Error(message);
  }
}

function extractToken(body: unknown): string {
  if (body && typeof body === 'object' && 'accessToken' in body && typeof body.accessToken === 'string') {
    return body.accessToken;
  }

  throw new Error('Authentication response did not include accessToken.');
}

function extractId(body: unknown): string {
  if (body && typeof body === 'object' && 'id' in body && typeof body.id === 'string') {
    return body.id;
  }

  throw new Error('Response did not include an id.');
}

function classifyHttpError(response: HttpResult, expected?: number[]): string {
  const expectedText = expected ? ` Expected ${expected.join(' or')}, received ${response.status}.` : '';
  const bodyText = response.text ? ` Body: ${truncate(response.text)}` : '';

  if (response.status === 0) {
    return `Connection problem.${bodyText}`;
  }
  if (response.status === 400 || response.status === 422) {
    return `Validation error.${expectedText}${bodyText}`;
  }
  if (response.status === 401 || response.status === 403) {
    return `Authentication or authorization error.${expectedText}${bodyText}`;
  }
  if (response.status >= 500) {
    return `Server error.${expectedText}${bodyText}`;
  }

  return `HTTP error.${expectedText}${bodyText}`;
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function printReport(results: TestResult[]): void {
  const detected = results.filter((result) => result.status !== 'SKIP').length;
  const passed = results.filter((result) => result.status === 'PASS').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const skipped = results.filter((result) => result.status === 'SKIP').length;

  console.log('');
  console.log('Functional report');
  console.log(`Detected/executed checks: ${detected}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log('');
  console.log('Status  Method   Endpoint        Check');

  for (const result of results) {
    console.log(
      `${result.status.padEnd(7)} ${(result.method ?? '-').padEnd(8)} ${(result.path ?? '-').padEnd(15)} ${result.name}`,
    );
    if (result.expected || result.received || result.durationMs !== undefined) {
      console.log(
        `        expected=${result.expected ?? '-'} received=${result.received ?? '-'} timeMs=${result.durationMs ?? '-'}`,
      );
    }
    if (result.detail) {
      console.log(`        ${result.detail}`);
    }
  }
}

function hasFailures(results: TestResult[]): boolean {
  return results.some((result) => result.status === 'FAIL');
}

function discoverNestEndpoints(): DiscoveredEndpoint[] {
  const srcDir = join(process.cwd(), 'src');
  if (!existsSync(srcDir)) {
    return [];
  }

  const endpoints: DiscoveredEndpoint[] = [];
  for (const file of listControllerFiles(srcDir)) {
    const content = readFileSync(file, 'utf8');
    const controllerMatch = content.match(/@Controller\((?:'([^']*)'|"([^"]*)")?\)/);
    const prefix = controllerMatch?.[1] ?? controllerMatch?.[2] ?? '';
    const routeRegex = /@(Get|Post|Patch|Delete|Put)\((?:'([^']*)'|"([^"]*)")?\)/g;
    let match: RegExpExecArray | null;

    while ((match = routeRegex.exec(content)) !== null) {
      endpoints.push({
        method: match[1].toUpperCase() as HttpMethod,
        path: joinRoute(prefix, match[2] ?? match[3] ?? ''),
      });
    }
  }

  return endpoints.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function listControllerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listControllerFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function joinRoute(prefix: string, routePath: string): string {
  const parts = [prefix, routePath].filter(Boolean).map((part) => part.replace(/^\/+|\/+$/g, ''));
  return `/${parts.join('/')}`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function truncate(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
