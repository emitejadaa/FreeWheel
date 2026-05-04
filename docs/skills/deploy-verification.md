# deploy-verification

Use this project skill after pushing changes or when a Render deploy may have completed.

Command:

```bash
npm run verify:render
```

Before verifying a new Render deploy, confirm the service uses:

```bash
npm run render:start
```

That command runs `prisma migrate deploy` before `npm run start:prod`, which avoids remote 500s caused by pending migrations.

Behavior:

- Requires `RENDER_API_URL`.
- Runs the Render endpoint checker with limited retries.
- Defaults to 5 attempts and 15 seconds between attempts.
- Supports `RENDER_VERIFY_ATTEMPTS` and `RENDER_VERIFY_DELAY_MS`.
- Does not claim the deploy finished; it only verifies the URL currently available.

If verification fails, check deploy status, env vars, migrations, Prisma errors, endpoint paths, and port binding.
