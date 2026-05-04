# frontend-backend-functional-test

Use this project skill when Rufluo needs to validate a local or hosted frontend/backend URL against only the functionality implemented in the current codebase.

Command:

```bash
npm run test:functional
```

Examples:

```bash
TARGET_URL=http://localhost:3000 npm run test:functional
TARGET_URL=https://freewheel-api.onrender.com npm run test:functional
FRONTEND_URL=https://freewheel.vercel.app API_BASE_URL=https://freewheel-api.onrender.com npm run test:functional
TEST_EMAIL=e2e-user@example.com TEST_PASSWORD=TestPassword123! API_BASE_URL=https://freewheel-api.onrender.com npm run test:functional
```

Inputs:

- `TARGET_URL`: required unless `API_BASE_URL` is set. Use it for one-host deployments or backend-only testing.
- `API_BASE_URL`: backend URL when frontend and backend are separate.
- `FRONTEND_URL`: frontend URL when validating browser-to-API deployment shape.
- `TEST_EMAIL` and `TEST_PASSWORD`: optional test credentials. If omitted, the runner registers a unique fake user when register exists.
- `FUNCTIONAL_TEST_TIMEOUT_MS`: optional request timeout, default `10000`.

Behavior:

- Detects backend endpoints from NestJS controllers.
- Probes OpenAPI/Swagger if exposed by the target, but does not invent tests from roadmap docs.
- Checks frontend host availability when `FRONTEND_URL` is separate from `API_BASE_URL`.
- Checks CORS preflight when frontend and backend are separate origins.
- Tests public endpoints such as `GET /` and `GET /listings` when implemented.
- Tests register/login when implemented.
- Tests protected user, vehicle and listing flows only after valid authentication.
- Uses fake unique data marked as `e2e-test-*`.
- Cleans up disposable resources when delete endpoints and business rules allow it.
- Exits non-zero if an executed check fails.

Do not use it to test:

- payments,
- email or SMS verification,
- admin panels,
- messaging,
- reservations,
- disputes,
- identity verification,
- any feature mentioned only as future roadmap.

Use automatically when:

- endpoints change,
- DTOs change,
- auth or guards change,
- frontend API clients/services/hooks change,
- a deploy is created,
- a hosted URL needs validation.

Report interpretation:

- `PASS`: implemented functionality responded as expected.
- `FAIL`: an executed real check failed; read the detail for HTTP status, validation, auth, CORS, server or connection errors.
- `SKIP`: functionality was not detected or optional, so it was not tested.
