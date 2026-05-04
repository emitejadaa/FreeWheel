# project-preflight

Use this project skill before important backend changes or before handing off a completed change.

Command:

```bash
npm run preflight
```

Behavior:

- Runs Prisma validate/generate.
- Runs build.
- Runs Jest tests.
- Attempts the local endpoint checker.

The endpoint checker requires a running local server. If the server is down, preflight reports that separately after the non-network checks.
