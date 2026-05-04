---
name: frontend-backend-functional-test
description: >
  Functional testing for deployed or local FreeWheel frontend/backend URLs. Use when validating a hosted URL, deploy, backend endpoint change, DTO change, auth change, or frontend HTTP call change. Runs only tests for functionality detected in the current codebase and avoids future features such as payments, email/SMS verification, admin panels, messaging, reservations, or identity checks unless implemented in code.
---

# Frontend Backend Functional Test Skill

## Purpose

Validate that the currently implemented frontend/backend flow works against a local or deployed URL without inventing tests for future roadmap features.

## Command

```bash
npm run test:functional
```

Common examples:

```bash
TARGET_URL=http://localhost:3000 npm run test:functional
TARGET_URL=https://freewheel-api.onrender.com npm run test:functional
FRONTEND_URL=https://freewheel.vercel.app API_BASE_URL=https://freewheel-api.onrender.com npm run test:functional
```

## Inputs

- `TARGET_URL`: URL to validate when frontend and backend share one host, or when testing only a backend URL.
- `API_BASE_URL`: backend API URL when frontend and backend are hosted separately.
- `FRONTEND_URL`: frontend URL when validating a separated frontend/backend deployment.
- `TEST_EMAIL` and `TEST_PASSWORD`: optional existing test credentials. If omitted and register/login exist, the runner creates a unique fake user.
- `FUNCTIONAL_TEST_TIMEOUT_MS`: optional request timeout. Defaults to `10000`.

## Workflow

1. Inspect local source first: `src/`, controllers, DTOs, Prisma schema, `ENDPOINTS.md`, README, and existing scripts.
2. Prefer OpenAPI/Swagger only if the deployed target exposes it, but still avoid undocumented future features.
3. Discover NestJS routes from decorators such as `@Controller`, `@Get`, `@Post`, `@Patch`, `@Put`, and `@Delete`.
4. If a frontend exists, inspect real HTTP clients/services/hooks and prioritize flows consumed by the frontend.
5. Run `npm run test:functional` with the URL variables supplied by the user.
6. Report detected features, passed checks, failed checks, skipped checks, HTTP errors, validation errors, auth errors, connection errors, and CORS issues.

## Rules

- Do not hardcode deploy URLs, tokens, credentials, or secrets.
- Do not test payments, email/SMS verification, admin features, messaging, reservations, disputes, or identity verification unless code implements the full flow.
- Do not invent JWTs or IDs. Authenticate only through implemented register/login or provided test credentials.
- Use fake unique test data with `e2e-test-*` naming.
- Clean up resources when a valid delete endpoint exists. If cleanup is blocked by real business rules, report it instead of forcing deletion.
- Exit non-zero when a real executed check fails.

## Current FreeWheel Coverage

For this backend, the runner can validate:

- `GET /`
- optional `GET /health`
- `POST /auth/register`
- `POST /auth/login`
- `GET/PATCH /users/me`
- `POST/GET/PATCH/DELETE /vehicles`
- `POST/GET/PATCH/DELETE /listings`
- public listing reads and authenticated ownership flows

