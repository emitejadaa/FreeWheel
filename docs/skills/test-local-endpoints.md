# test-local-endpoints

Use this project skill when backend API changes need a fast local smoke test.

Command:

```bash
npm run test:endpoints:local
```

Behavior:

- Uses `LOCAL_API_URL` when defined, otherwise `http://localhost:3000`.
- Discovers NestJS controller routes from `src/**/*.controller.ts`.
- Tests public critical endpoints currently available without auth: `GET /` and `GET /listings`.
- Probes `GET /health` only as an optional endpoint; a 404 is reported as skipped.
- Does not invent JWTs, users, IDs, or database records.
- Exits non-zero when a critical public endpoint fails.

Start the backend first with `npm run start:dev` when testing manually.
