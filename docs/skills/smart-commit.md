# smart-commit

Use this project skill when a coherent change is complete and ready to commit.

Command:

```bash
npm run commit:smart
```

To create a commit after reviewing output:

```bash
git add <related-files>
npm run commit:smart -- --commit "docs(agents): document endpoint testing workflow"
```

Rules:

- Reviews `git status` and diff stat before committing.
- Refuses obvious secret-related file changes.
- Requires Conventional Commit format.
- Runs `npm run build` and `npm test -- --runInBand` before committing.
- Commits only explicitly staged files.
- Does not automatically push.

Use short messages like `test(api): add render endpoint checker` or `docs(readme): update local setup`.
