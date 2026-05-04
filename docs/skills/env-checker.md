# env-checker

Use this project skill when env vars, deployment configuration, or onboarding docs change.

Command:

```bash
npm run check:env
```

Behavior:

- Ensures `.env.example` exists with placeholders only.
- Checks required runtime variables in the current environment.
- Documents optional variables used by local and Render endpoint checkers.
- Never prints secret values.

Required today: `DATABASE_URL`, `JWT_SECRET`.

Optional documented variables: `DIRECT_URL`, `JWT_EXPIRES_IN`, `PORT`, `LOCAL_API_URL`, `RENDER_API_URL`, `SENDGRID_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
