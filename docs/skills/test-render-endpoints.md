# test-render-endpoints

Use this project skill when the deployed Render backend must be smoke-tested.

Command:

```bash
npm run test:endpoints:render
```

Behavior:

- Requires `RENDER_API_URL`.
- Never hardcodes or infers the Render URL.
- Tests the same public critical endpoints as the local checker.
- Reports method, endpoint, expected status, received status, response time, and result.
- Exits non-zero when Render does not respond or a critical endpoint fails.

If `RENDER_API_URL` is missing, configure it in the shell, CI secret, or deployment documentation.
