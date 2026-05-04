---
name: render-hosting-control
description: Control FreeWheel hosting on Render with the official Render CLI. Use when Codex needs to manually redeploy Render, validate render.yaml, list deploys, inspect deploy/runtime logs, confirm Render env requirements, or verify the deployed backend/frontend flow after changes.
---

# Render Hosting Control

Use this skill for Render operations that need deploy control or production diagnosis.

## Requirements

- Use the official Render CLI through project scripts.
- Required for service-specific commands: `RENDER_SERVICE_ID`.
- Required for non-interactive automation: `RENDER_API_KEY`.
- Optional for Blueprint validation: `RENDER_WORKSPACE_ID` when the CLI has no active workspace.
- Optional: `RENDER_CLI_PATH` when the `render` binary is not on `PATH`; on this Windows machine the wrapper auto-detects `C:\Users\49380010\bin\render-cli\cli_v2.16.0.exe`.
- Never commit real API keys, tokens, database URLs, JWT secrets, or dashboard-only credentials.

## Commands

- Validate Blueprint: `npm run render:validate`.
- Trigger deploy and wait for completion: `npm run render:deploy`.
- Trigger deploy without waiting: `npm run render:deploy:no-wait`.
- List recent deploys: `npm run render:deploys`.
- Fetch logs: `npm run render:logs`.
- List accessible services: `npm run render:services`.

Pass extra CLI flags after `--`, for example:

```bash
npm run render:deploy -- --clear-cache
npm run render:deploy -- --commit cb020ee7dee8b41e7d8be4f7081f080f0bb87ab0
npm run render:logs -- --path /auth/register --status-code 500
```

## Deployment Workflow

1. Run local checks first: `npm run build`, `npm test`, and any task-specific checks.
2. Push the relevant commit before deploying a Git-backed Render service.
3. Run `npm run render:validate`.
4. Run `npm run render:deploy`.
5. If deploy fails, run `npm run render:deploys` and `npm run render:logs`.
6. Verify the deployed API with `npm run verify:render`.
7. For frontend/backend flows, run `FRONTEND_URL=... API_BASE_URL=... npm run test:functional`.

## Diagnosis Notes

- A browser CORS failure can hide a backend `500` from a failed preflight. Reproduce with `OPTIONS` and an `Origin` header.
- Thunder/Postman requests can pass while browser requests fail because they do not enforce CORS.
- If CLI deploy commands fail before reaching Render, check `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `RENDER_WORKSPACE_ID`, and `RENDER_CLI_PATH`.
- If the deploy succeeds but behavior does not change, confirm the service is linked to the expected Git branch and commit.
