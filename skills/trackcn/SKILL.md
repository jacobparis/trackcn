---
name: trackcn
description: Use the trackcn CLI to sync files, directories, commits, pull requests, and agent skills from GitHub into a codebase while preserving local edits. Read this before running trackcn commands or modifying trackcn-managed files.
allowed-tools: Bash(trackcn:*), Bash(npx trackcn:*)
---

# trackcn

`trackcn` syncs files from GitHub into a codebase and records their upstream
versions in `trackcn.json`. It protects local edits with a three-hash merge
workflow so an agent can reconcile upstream changes deliberately.

## Core loop

```bash
trackcn status --json
trackcn pull --dry-run --json
trackcn pull --json
```

Read `trackcn.json` before modifying a tracked file. A file listed under a
source's `files` map is managed by trackcn. If you need a local override, prefer
adding a separate file outside the managed path instead of hand-editing the
tracked file.

## Add a source

```bash
# Raw file
trackcn add https://example.com/config.txt

# GitHub file or directory
trackcn add https://github.com/owner/repo/tree/main/path/to/directory
trackcn add https://github.com/owner/repo/blob/main/path/to/file.ts
trackcn add owner/repo/path/to/directory
trackcn add owner/repo/tree/main/path/to/directory

# Gist, commit, commit range, or pull request
trackcn add https://gist.github.com/user/abc123
trackcn add https://github.com/owner/repo/commit/abc1234
trackcn add https://github.com/owner/repo/compare/v1.0...v2.0
trackcn add https://github.com/owner/repo/pull/42
```

Add a local destination as the last argument when the upstream path should not
be written at the repository root:

```bash
trackcn add owner/repo/path/to/skill ./.cursor/skills/my-skill
```

For multiple sources, use a destination ending in `/`. trackcn derives one
subdirectory per source:

```bash
trackcn add \
  owner/repo/skills/frontend-design \
  owner/repo/skills/testing \
  ./.cursor/skills/
```

Use `--dry-run` to preview writes, `--force` to overwrite local files
deliberately, and `--json` when another tool will consume the result.

## Install curated GitHub registry items

If a repository defines a root shadcn `registry.json`, inspect its install
options and curated bundles with:

```bash
trackcn add owner/repo
```

Install and subscribe to a curated bundle with:

```bash
trackcn add owner/repo/item
trackcn add owner/repo/item#v1.0.0
```

Use `trackcn add owner/repo .` when the complete repository should be installed.
For an unambiguous repository path, use `owner/repo/tree/ref/path` or
`owner/repo/blob/ref/path`. A short `owner/repo/path` resolves a curated
registry item first and falls back to the repository's actual default branch.

trackcn consumes shadcn's GitHub registry format instead of defining a competing
catalog schema. Curated bundles are recorded in `trackcn.json`, so use
`trackcn status` and `trackcn pull` to keep them current.

## Pull updates

```bash
trackcn pull --dry-run --json
trackcn pull --json
```

When upstream changed and the local file still matches the stored hash, trackcn
updates it directly. When both upstream and the local file changed, trackcn
prepends a `<<<<<<< trackcn` marker block and reports the file in `merged`.

After a merge:

1. Open every file listed in `merged`.
2. Treat each marker block as an upstream diff and the content below the
   blocks as the local version. Successive upstream changes stack as separate
   blocks, newest first — apply them oldest-to-newest.
3. Reconcile the intended result in the file. The diff is upstream-only
   (old upstream → new upstream), so applying it never removes local edits.
4. Remove every marker block, including the `<<<<<<< trackcn` and
   `>>>>>>> trackcn` lines.
5. Run tests or validation for the affected code.
6. Run `trackcn status --json` and confirm there are no unresolved merges.

Do not run `trackcn pull --force` unless discarding local edits is intentional.

## Check status

```bash
trackcn status
trackcn status --json
```

`status` exits `0` when all sources are current and managed files match their
stored hashes. It exits `1` when an upstream moved, a managed file changed
locally, or a merge marker is unresolved. In CI:

```yaml
- run: npx trackcn status
```

## Remove a source

```bash
# Stop tracking the source but leave its files on disk
trackcn remove owner/repo/path

# Stop tracking the source and delete its tracked files
trackcn remove owner/repo/path --hard
```

Use a partial URL when it uniquely identifies one source. Inspect
`trackcn.json` first when using `--hard`.

## Agent skills recipe

Agent skills are ordinary GitHub directories. Track project-specific skills
inside the repository:

```bash
trackcn add https://github.com/owner/skills/tree/main/skills ./.cursor/skills
git add trackcn.json .cursor/skills
```

Run trackcn from `$HOME` instead when you want a user-level manifest and
user-level skill directory:

```bash
cd ~
trackcn add https://github.com/owner/skills/tree/main/skills ./.cursor/skills
```

Do not hand-edit trackcn-managed skill files. Track a fork or place a local
override outside the managed directory when different behavior is required.

## Post-pull hooks

Attach a shell command that should run after a source changes:

```bash
trackcn add owner/repo/icons ./icons --post-pull "npm run build:icons"
```

Hooks execute shell commands from `trackcn.json`. Inspect unfamiliar manifests
before pulling.

## Authentication

Set `TRACKCN_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN` when GitHub API
requests need authentication or a higher rate limit:

```bash
TRACKCN_GITHUB_TOKEN=... trackcn pull
```

For interactive use, trackcn can store a browser login outside the manifest:

```bash
trackcn auth login
trackcn auth status
trackcn auth logout
```

A stored login lives in `~/.trackcn/auth.json`, never in `trackcn.json`. In CI
or headless environments, use a token env var instead — the browser flow only
auto-starts at an interactive terminal.

## Load this guide again

```bash
trackcn skills get trackcn
trackcn skills path trackcn
```
