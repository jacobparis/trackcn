# Agent guide

This repository is the publishable `trackcn` CLI package. The README is the public landing page.

## Scope

- Keep the repo focused on the CLI, bundled skill, tests, README, SPEC, and release metadata.
- Do not add the previous Next.js app, GitHub clone UI, captured examples, reference checkouts, local agent folders, or build caches.
- Keep the package root flat: `src/`, `dist/`, `skills/`, and tests live at the repository root.

## Common commands

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm pack:check
```

## Release checks

Before publishing, verify:

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `npm pack --dry-run`

The package publishes the CLI binary `trackcn` and includes `dist/`, `skills/`, `README.md`, `SPEC.md`, and `LICENSE`.
