# frontend-backend-functional-test

Reusable Rufluo/Codex skill for validating only the frontend/backend functionality implemented in this repo.

Run:

```bash
TARGET_URL=http://localhost:3000 npm run test:functional
FRONTEND_URL=https://freewheel.vercel.app API_BASE_URL=https://freewheel-api.onrender.com npm run test:functional
```

The runner discovers local NestJS controllers, creates fake `e2e-test-*` data only when auth endpoints exist, and reports pass/fail/skip results without testing roadmap-only features.

