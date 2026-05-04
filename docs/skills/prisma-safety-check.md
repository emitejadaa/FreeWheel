# prisma-safety-check

Use this project skill when Prisma schema, migrations, or database access could be affected.

Command:

```bash
npm run check:prisma
```

Behavior:

- Runs `npx prisma validate`.
- Runs `npx prisma generate`.
- Detects uncommitted `prisma/schema.prisma` changes and warns about migration review.
- Does not run migrations, `db push`, or destructive operations.

Recommended local migration command after explicit review:

```bash
npx prisma migrate dev
```

Production migrations must be coordinated with the deployment environment and confirmed explicitly.
