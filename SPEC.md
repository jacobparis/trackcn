# trackcn specification

Sync files, commits, and pull requests from GitHub into your codebase. Track upstream changes. Let agents handle the merges.

## Publishing boundary

trackcn does not define another outbound package catalog. Public repositories use [shadcn GitHub registries](https://ui.shadcn.com/docs/registry/github) to publish selected files, configs, docs, templates, workflows, rules, and project conventions:

1. Add a root `registry.json`.
2. Define one or more installable items.
3. Validate with `pnpm dlx shadcn@latest registry validate <owner>/<repo>`.
4. Subscribe with `trackcn add <owner>/<repo>/<item>`.

The registry format remains owned by shadcn. trackcn adds tracked updates: curated bundles and consumer-selected GitHub sources both flow through `trackcn.json`, `status`, and `pull`.

## Commands

### `trackcn add <url...> [directory]`

Fetch files or apply changesets from one or more GitHub sources.

```
trackcn add https://gist.github.com/user/abc123
trackcn add org/repo
trackcn add org/repo .
trackcn add org/repo/project-conventions
trackcn add org/repo/project-conventions#v1.0.0
trackcn add https://github.com/org/repo/tree/main/src/components
trackcn add org/repo/path
trackcn add https://github.com/org/repo/blob/main/config.json
trackcn add https://github.com/org/repo/blob/main/styles.css#L227-L300
trackcn add https://github.com/org/repo/commit/abc1234
trackcn add https://github.com/org/repo/compare/v1.0...v2.0
trackcn add https://github.com/org/repo/pull/42
trackcn add .../frontend-design ./.claude/skills/frontend-design
trackcn add .../frontend-design .../pdf ./.claude/skills/
```

**Directory target:** If any argument starts with `.` or `/`, it's the local directory. Everything else is a URL. Trailing `/` on the directory derives subdirectory names from each URL's last path segment.

**Options:**
- `--post-pull <command>` — shell command to run after this source's files change on pull
- `--force` — overwrite pre-existing files and locally modified tracked files
- `--dry-run` — show what would happen without writing
- `--json` — structured output for agents

**Behavior for file sources (gist, repo, raw):**
1. Fetches all files from each source
2. For each regular file, checks before writing:
   - **File doesn't exist** — write it
   - **File exists, tracked by this source, unmodified** — overwrite (safe update)
   - **File exists, tracked by this source, user modified** — prepend merge markers
   - **File exists, not tracked by this source** — skip (use `--force` to overwrite)
   - **File content already matches** — update tracking, no write needed
3. Stages patch/prompt files to temp paths and reports them
4. Records the source URL, version SHA, and per-file content hashes in `trackcn.json`

**Behavior for shadcn-format GitHub registry bundles:**
1. `trackcn add <owner>/<repo>` prints a help menu and lists root `registry.json` items when present. It does not write a manifest.
2. `trackcn add <owner>/<repo> .` installs the complete repository using its actual default branch.
3. `trackcn add <owner>/<repo>/<item>` resolves a curated registry item first, then falls back to a repository path when no item matches.
4. Registry `include` files, nested item names, `~/` project-root targets, same-repository dependencies, and optional `#ref` pins are supported.
5. Registry bundles are tracked as sources so `status`, `pull`, and `remove` work normally.

**Behavior for changeset sources (commit, commit-range, pull):**
1. Fetches the changeset (diff) from the GitHub API
2. For each changed file in the changeset:
   - **added** — write the new file (skip if file exists and differs, unless `--force`)
   - **modified** — if file doesn't exist locally, write it. If file exists unmodified, overwrite. If file exists and user modified, prepend merge markers with the upstream patch.
   - **removed** — delete if tracked and unmodified. Skip if user modified.
   - **renamed** — rename locally, apply content changes. Merge markers if user modified with content change.
3. Records the source URL, version SHA, and per-file content hashes in `trackcn.json`

### `trackcn pull`

Update all tracked sources.

```
trackcn pull
trackcn pull --dry-run
trackcn pull --force
trackcn pull --json
```

**Options:**
- `--dry-run` — show what would happen without writing
- `--force` — overwrite locally modified files instead of adding merge markers
- `--json` — structured output for agents

**Principle:** if the file on disk matches what trackcn last wrote, follow the upstream operation. If the user modified it, protect it.

**Behavior per source type:**

**Repo sources:**
1. Check if the upstream commit SHA changed. If not, skip.
2. Use the GitHub Compare API to get the exact changes (with rename tracking).
3. For each changed file, apply using the three-hash check (stored, disk, upstream).
4. Run `post-pull` hooks for sources that had changes.
5. Update `trackcn.json` with new version SHA and file hashes.

**GitHub registry bundle sources:**
1. Check the selected ref's commit SHA. If it changed, resolve the bundle again.
2. Full-refetch the bundle so newly added, removed, or retargeted files are handled.
3. Apply the same three-hash protection used by other sources.
4. Preserve dependency and environment requirements in `trackcn.json` and report them to the caller.

**Gist sources:**
1. Fetch latest version. If version SHA unchanged, skip.
2. Fetch both old and new versions, diff locally with `diff -u`.
3. Apply changes using same three-hash logic.
4. Handle deletions (files removed from gist).

**Raw URL sources:**
1. Re-fetch content. If content hash unchanged, skip.
2. Apply using same protection logic.

**Commit sources:**
1. Immutable. Nothing to pull. Commits don't change.

**Commit-range sources:**
1. If head is a branch name, resolve to latest SHA.
2. If SHA unchanged from stored version, skip.
3. Compute diff from stored version to new head via Compare API.
4. Apply changeset to local files.

**Pull request sources:**
1. Fetch latest head SHA from PR API.
2. If unchanged from stored version, skip.
3. Compute diff from stored version to new head via Compare API.
4. Apply changeset to local files.

**Line-range repo sources:**
1. Full refetch of the file, slice to requested lines.
2. Apply using same protection logic as regular repo sources.

### `trackcn status`

Check for upstream changes and local drift without modifying anything.

```
trackcn status
trackcn status --json
```

**Exit codes:**
- `0` — everything up to date, no local drift
- `1` — upstream has changes, local files have drifted, or an upstream check failed

**Detects:**
- Upstream version changes (new commits, new gist revisions, changed content)
- Locally modified files (disk hash != stored hash)
- Missing files (tracked but deleted locally)
- Unresolved merge markers (`<<<<<<< trackcn` still in file)
- Commits always report up to date (immutable)
- Commit ranges resolve head to check for new commits
- PRs check for new head SHA

### `trackcn remove <url>`

Untrack a source. Alias: `rm`.

```
trackcn remove anthropics/skills/skills/frontend-design
trackcn rm frontend-design
trackcn remove <url> --hard
```

**Options:**
- `--hard` — delete the tracked files from disk (default: leave them)
- `--json` — structured output

Supports partial URL matching: if the input is a substring of a tracked source URL, it matches.

## Sources

### GitHub gists

URL formats:
- `https://gist.github.com/user/abc123`
- `https://gist.github.com/abc123`
- `abc123def456...` (raw hex ID, 20+ chars)

Gist filenames use underscore encoding for paths: `app_api_route.ts` becomes `app/api/route.ts`.

Version tracking uses the gist's version SHA from its commit history.

### GitHub repos (files and directories)

URL formats:
- `owner/repo` — print repository install options and curated bundles
- `owner/repo .` — install the complete repository using its default branch
- `owner/repo/path` — curated registry item first, then repository-path fallback
- `owner/repo/tree/ref/path/to/dir` — explicit shorthand directory
- `owner/repo/blob/ref/path/to/file` — explicit shorthand file
- `https://github.com/owner/repo/tree/ref/path/to/dir` — directory
- `https://github.com/owner/repo/blob/ref/path/to/file` — single file
- `https://github.com/owner/repo/blob/ref/path/to/file#L10-L20` — line range

Version tracking uses the branch's HEAD commit SHA. The Compare API provides rename detection and per-file diffs on pull.

### GitHub registry bundles

When a repository publishes a root shadcn `registry.json`, `trackcn add owner/repo/item` installs and tracks that curated bundle. Item names can contain `/`, and `#ref` can select a branch, tag, or commit SHA:

```
trackcn add acme/toolkit/project-conventions
trackcn add acme/toolkit/rules/agent
trackcn add acme/toolkit/project-conventions#v1.0.0
```

trackcn resolves registry items before repository-path fallback. Use the explicit `tree` or `blob` shorthand when the input must be treated as a path.

### GitHub commits

URL format:
- `https://github.com/owner/repo/commit/<sha>`

Applies the commit's diff as a changeset. Tracked in manifest. Immutable — `trackcn pull` is a no-op, `trackcn status` only checks local drift.

### GitHub commit ranges

URL format:
- `https://github.com/owner/repo/compare/<base>...<head>`

Applies the combined diff between base and head. If head is a branch name, `trackcn pull` resolves it to the latest SHA and applies incremental changes.

### GitHub pull requests

URL format:
- `https://github.com/owner/repo/pull/<number>`

Resolves the PR to its base...head, applies the combined diff. `trackcn pull` detects new commits pushed to the PR and applies incremental changes.

### Raw URLs

Any `https://` URL that isn't GitHub. Fetches as a single file. Version is the content hash.

### Line ranges

Append `#L<start>` or `#L<start>-L<end>` to any GitHub blob URL:
- `https://github.com/owner/repo/blob/main/styles.css#L227`
- `https://github.com/owner/repo/blob/main/styles.css#L227-L300`

Fetches the full file, extracts the requested lines. Only works with single file URLs, not directories. The line range is preserved in the canonical URL, so each range is a separate tracked source.

## File types

### Regular files

Copied directly to the target path.

### Patch files

Named `NNN_target.patch` (e.g., `001_package.json.patch`). Contain unified diffs. Staged to a temp directory and reported for the caller (agent) to apply. trackcn does not apply patches itself.

### Prompt files

Named `*.prompt.md`. Contain natural-language instructions for agents. Staged to temp and reported.

## Manifest: `trackcn.json`

Lives at project root. Committed to the repo.

```json
{
  "sources": [
    {
      "url": "https://gist.github.com/abc123",
      "version": "4d67b9d09224f63e7493b35e93b868fa4b1359e8",
      "files": {
        "lib/utils.ts": "sha256...",
        "app/page.tsx": "sha256..."
      }
    },
    {
      "url": "https://github.com/owner/repo/pull/42",
      "version": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "files": {
        "src/feature.ts": "sha256...",
        "src/feature.test.ts": "sha256..."
      }
    }
  ]
}
```

Each source owns its files. File paths are relative to project root. The `files` object maps paths to SHA-256 hashes of the content trackcn last wrote. These detect local modifications.

The `version` field is the gist version SHA, repo commit SHA, commit SHA, resolved head SHA (for ranges/PRs), or content hash (for raw URLs).

The optional `post-pull` field is a shell command run when that source's files change during pull.

## Merge markers

When a file has been modified both locally and upstream, trackcn prepends conflict markers:

```
<<<<<<< trackcn
@@ -1,3 +1,7 @@
 export function greet(name: string): string {
   return `Hello, ${name}!`;
 }
+
+export function farewell(name: string): string {
+  return `Goodbye, ${name}!`;
+}
>>>>>>> trackcn
export function greet(name: string): string {
  return `Hello, ${name}! Welcome to the app.`;
}
```

The diff between `<<<<<<< trackcn` and `>>>>>>> trackcn` shows what changed upstream. The code below is the user's current version. The file is intentionally invalid until the markers are resolved.

After adding markers, trackcn updates the stored hash to the new upstream content hash. This means a second `pull` won't pile on another marker block.

## Three-hash merge logic

For every file operation, trackcn checks three values:
- **Stored hash** — what trackcn last wrote (from `trackcn.json`)
- **Disk hash** — what's on disk now
- **Upstream hash** — what the source has now

| Stored == Disk | Upstream changed | Action |
|---|---|---|
| Yes | Yes | Overwrite (safe) |
| Yes | No | Skip (nothing changed) |
| No | No | Skip (only user changed) |
| No | Yes | Prepend merge markers |

## Machine output

All commands accept `--json`.

### `add --json` (file sources)

```json
{
  "source": "https://gist.github.com/abc123",
  "description": "my config files",
  "added": ["lib/utils.ts", "app/page.tsx"],
  "merged": [],
  "skipped": [],
  "patches": [
    {"path": "/tmp/trackcn-xxx/patches/001_package.json.patch", "target": "package.json"}
  ],
  "prompts": []
}
```

### `add --json` (changeset sources)

```json
{
  "source": "https://github.com/owner/repo/pull/42",
  "description": "owner/repo#42: Add feature X",
  "added": ["src/feature.ts"],
  "merged": ["src/existing.ts"],
  "deleted": [],
  "renamed": [],
  "skipped": []
}
```

### `pull --json`

```json
{
  "added": ["new-file.ts"],
  "updated": ["lib/utils.ts"],
  "deleted": ["old-file.ts"],
  "renamed": ["old-name.ts -> new-name.ts"],
  "skipped": ["config.ts"],
  "merged": ["app/page.tsx"],
  "hooksRun": ["npm install"],
  "errors": []
}
```

### `status --json`

```json
{
  "sources": [
    {
      "url": "https://gist.github.com/abc123",
      "upToDate": false,
      "currentVersion": "abc123...",
      "latestVersion": "def456...",
      "versionChanged": true,
      "files": 3,
      "locallyModified": ["lib/utils.ts"],
      "missing": [],
      "unresolvedMerges": ["app/page.tsx"]
    }
  ],
  "stale": true,
  "drifted": true,
  "failed": false
}
```

## Agent workflow

**Adding a source with patches:**
```
agent runs:  trackcn add <url> --json
agent reads: { "patches": [{"path": "/tmp/...", "target": "package.json"}] }
agent reads: the patch file at that path
agent runs:  Edit tool to apply the patch to package.json
```

**Pulling with merge conflicts:**
```
agent runs:  trackcn pull --json
agent reads: { "merged": ["app/page.tsx"] }
agent reads: app/page.tsx — sees <<<<<<< trackcn markers with the upstream diff
agent runs:  Edit tool to apply the diff, then removes the marker block
```

**Applying a commit:**
```
agent runs:  trackcn add https://github.com/owner/repo/commit/abc123 --json
agent reads: { "added": [...], "merged": [...] }
agent reads: any merged files to resolve markers
```

**Applying a PR:**
```
agent runs:  trackcn add https://github.com/owner/repo/pull/42 --json
agent reads: { "added": [...], "merged": [...] }
later:       trackcn pull --json   (picks up new commits on the PR)
```

**CI compliance check:**
```yaml
- run: npx trackcn status
  # exits 1 if any source is stale or any file has drifted
```

## Safety

One principle: **if the file on disk matches what trackcn last wrote (stored hash), the upstream operation is safe. If the user modified it, protect the file.**

| Scenario | Action |
|---|---|
| File matches stored hash, upstream changed | Overwrite silently |
| File matches stored hash, upstream deleted | Delete silently |
| File modified by user, upstream changed | Prepend merge markers |
| File modified by user, upstream deleted | Skip with warning |
| File exists but not tracked by this source (`add`) | Skip (use `--force`) |
| `--force` on any command | Override all protections |
| `--dry-run` on `add` or `pull` | Show what would happen without writing project files or `trackcn.json` |

Every destructive operation has an inverse:

| Action | Undo |
|---|---|
| `add` wrote files | `remove --hard` |
| `pull` overwrote/deleted/merged | `git checkout .` or `remove --hard` + `add` |
| `remove` untracked a source | `add` the URL again |
| `remove --hard` deleted files | `add` to reinstall |

## Tracing

- Local trace log at `.trackcn/trace.log` with JSON events and GitHub API timings.

## Authentication

`GITHUB_TOKEN` env var enables authenticated API access (5000 req/hr vs 60/hr unauthenticated). Used for all GitHub API calls. Rate limit errors (403) suggest setting this variable.

---

## Recipes

Concrete patterns for common trackcn use-cases. Each recipe is a worked example with the commands, the resulting manifest entry, and the trade-offs.

### Skills (Claude, Cursor, agnostic)

Agent skills are just collections of markdown files in a GitHub directory. trackcn doesn't know or care which agent consumes them — `add` writes files to a destination, `pull` keeps them current, the agent reads them from disk.

**Surfaces by agent:**

| Agent | Project surface | User surface |
|---|---|---|
| Claude | `./.claude/skills/` | `~/.claude/skills/` |
| Cursor (skills) | `./.cursor/skills/` | `~/.cursor/skills/` |
| Cursor (rules, auto-attach) | `./.cursor/rules/*.mdc` | `~/.cursor/rules/` |
| Cursor (commands) | `./.cursor/commands/` | `~/.cursor/commands/` |

The split between project and user is a function of *where you run trackcn*. The manifest always lives at `process.cwd()` and tracks paths relative to it. Run from a repo root → project scope; run from `$HOME` → user scope. There is no "user mode" flag.

**Project-level (per-repo, committed alongside the manifest):**

```
cd ~/Projects/my-app
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
git add trackcn.json .cursor/skills
git commit -m "Track mattpocock/skills via trackcn"
```

Use this when the skills encode *how this codebase is built*. Pinned SHA travels with the repo, every collaborator and every CI run gets the same content.

**User-level (per-machine, optionally tracked in dotfiles):**

```
cd ~
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
```

Manifest lives at `~/trackcn.json`. Move it into a dotfiles repo for history, or leave it untracked — `trackcn pull` works either way. Use this for skills that encode *your personal workflow*, independent of project.

**Selective install with trailing-slash directory:**

When the destination ends with `/`, trackcn derives a subdirectory from each URL's last path segment (per the `add` command behavior). Useful for cherry-picking individual skills:

```
trackcn add \
  https://github.com/mattpocock/skills/tree/main/skills/engineering \
  https://github.com/mattpocock/skills/tree/main/skills/productivity \
  ./.cursor/skills/
```

Result: `./.cursor/skills/engineering/...` and `./.cursor/skills/productivity/...`, tracked as two independent sources in `trackcn.json`. Each pulls and removes independently.

**Tracking the same upstream for both Claude and Cursor:**

Two source entries, same SHA, both directories stay in sync on `trackcn pull`:

```
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.claude/skills
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
```

Cheaper alternative if you don't need both committed: track once and symlink the other:

```
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
ln -s .cursor/skills .claude/skills
```

Trade-off: symlinks don't survive Windows clones cleanly.

**Cursor: convert a skill into an auto-attaching rule.**

Cursor rules (`.cursor/rules/*.mdc`) auto-fire on glob matches; skills wait for the agent to invoke them. To get auto-attach behavior on a tracked skill, write a thin local `.mdc` wrapper that references it:

```
---
description: TypeScript conventions
globs: ["**/*.ts", "**/*.tsx"]
alwaysApply: false
---

See `.cursor/skills/typescript/SKILL.md` for full conventions.
```

The wrapper is local (not trackcn-tracked), so editing it never triggers a merge marker. The skill content stays under trackcn's three-hash protection.

**Update workflow:**

```
trackcn pull              # apply upstream changes; merge markers if local edits collide
trackcn pull --dry-run    # preview only
trackcn status            # exit 1 if upstream moved or local files drifted
```

When `pull` writes merge markers, the file becomes intentionally invalid (per the merge marker spec above). The expected resolution path is "tell the agent to run `trackcn pull` and reconcile" — agents read the diff in the `<<<<<<< trackcn` block, decide whether to keep upstream or local, remove the markers.

**CI gate:**

```yaml
- run: npx trackcn status
  # exits 1 if any source is stale or any file has drifted
```

Fails the build when the pinned skills SHA falls behind upstream, or when someone hand-edited a tracked skill without resolving via `trackcn pull`.

**Granularity decision tree:**

- Want every skill from a curated repo, accept the maintainer's category structure → one source pointing at the parent directory.
- Want to opt in/out of skills individually, or want each one to remove independently → trailing-slash multi-source pattern, one entry per skill or per category.
- Want to override one skill's frontmatter or globs locally → don't edit the tracked file (merge markers will follow). Either fork upstream and track your fork, or write a higher-priority local file that references the tracked one.

**This repo's worked example:**

`trackcn.json` at the root tracks `https://github.com/mattpocock/skills/tree/main/skills` into `./.cursor/skills/`. Run `trackcn pull` from repo root to update; run `trackcn status` to check for drift.

---

## Gaps: what's missing per README use-case

### "shadcn for gists" — fully working

Track files from gists, pull updates, agent-resolved merge conflicts. No gaps.

### "shadcn for github" — fully working

Point to any file or directory in any GitHub repo. Track, pull, status. No gaps.

### "repository-authored catalog" — shadcn-compatible and tracked

Public repositories expose curated installable items with a root shadcn `registry.json`. Consumers subscribe with `trackcn add <owner>/<repo>/<item>`, then use the same `status`, `pull`, and `remove` workflow as any other trackcn source.

trackcn deliberately does not add a second catalog schema. It consumes shadcn's GitHub registry format and adds tracked updates.

### "shadcn for skills" — fully working

Skills are just GitHub directories. `trackcn add org/skills/frontend-design ./.claude/skills/frontend-design` works. No gaps.

### "shadcn for icons" (post-install hooks) — fully working

`--post-pull` hooks run after changes. `trackcn add <svg-source> --post-pull "npm run build:icons"`. No gaps.

### "pull prose styles from global.css#L227" (line ranges) — implemented, needs polish

**What works:** `trackcn add .../global.css#L227` and `#L227-L300` extract the specified lines on initial add. Tracked as separate sources.

**Gaps:**
- [ ] **Pull doesn't slice on update.** When pulling updates for a line-range source, the Compare API path doesn't apply line slicing — it works on full-file diffs. The full-refetch fallback would need line slicing added. Currently line-range sources only get correct content on initial add, not on subsequent pulls.
- [ ] **No line-range awareness in shorthand URLs.** `owner/repo/path/file.ts#L10` doesn't work because the shorthand parser doesn't strip fragments. Only full `blob` URLs support line ranges.

### "shadcn for commits" — implemented, needs testing

**What works:** `trackcn add owner/repo/commit/<sha>` and the full GitHub URL fetch the commit, apply its changeset (added/modified/removed/renamed files), and track it in the manifest.

**Gaps:**
- [ ] **No `owner/repo@sha` alias.** Use `owner/repo/commit/<sha>`.
- [ ] **Large commits truncated.** GitHub Commits API caps file list at 300 files. No pagination. Same limitation exists for Compare API in pull.
- [ ] **No parent-commit awareness.** A single commit's diff is relative to its parent. If the commit is a merge commit, the diff may not represent what the user expects. No special handling for merge commits.

### "shadcn for commit ranges" — implemented, needs testing

**What works:** `trackcn add owner/repo/compare/v1.0...v2.0` and the full GitHub URL apply the combined diff. If head is a branch name, `trackcn pull` picks up new commits.

**Gaps:**
- [ ] **300-file truncation** on Compare API. No pagination.
- [ ] **Force-pushed branches.** If the base branch is force-pushed, the stored base SHA may no longer exist. Compare API will fail. No fallback.

### "shadcn for pull requests" — implemented, needs testing

**What works:** `trackcn add owner/repo/pull/42` and the full GitHub URL resolve PR to base...head and apply the changeset. `trackcn pull` detects new commits and applies incremental changes.

**Gaps:**
- [ ] **No `owner/repo#42` alias.** Use `owner/repo/pull/42`.
- [ ] **Closed/merged PRs.** No special handling. The API still returns data but the head ref may be deleted.
- [ ] **PR description/labels not used.** The PR title is shown in output but its description, labels, and review status are ignored. Could inform the agent.
- [ ] **300-file truncation** on Compare API.

### "shadcn for templates" (commit delta install) — not fully realized

README vision: "target specifically the commits after the base template and install only the changes."

**What partially works:** `trackcn add https://github.com/vercel/examples/compare/<base-template-sha>...<integration-sha>` would apply only the delta. This is a commit-range use case.

**Gaps:**
- [ ] **No template-aware workflow.** The user has to manually find the base template SHA and the integration SHA. There's no `trackcn add --after <template-sha> <url>` or automatic detection of where the base template ends.
- [ ] **Template base SHA discovery.** For Vercel marketplace templates that live in a monorepo, the user needs to find the commit where the integration code was added on top of the base `create-next-app` template. This is manual.
- [ ] **Path scoping for commit ranges.** When applying a commit range from a monorepo, all changed files are applied — not just files within a specific subdirectory. Need a way to scope: `trackcn add .../compare/base...head --path examples/sentry-integration/`.

### "github agent watching upstreams" — not built (paid tier)

Acknowledged as future paid feature. No gaps to track here.

---

## Test plan

Each test should be runnable against a real or mocked GitHub API. Tests use a temp directory as the project root.

### URL parsing

```
test: parseUrl("https://gist.github.com/user/abc123") → { type: "gist", gist: "abc123" }
test: parseUrl("https://gist.github.com/abc123") → { type: "gist", gist: "abc123" }
test: parseUrl("abc123def456789012345") → { type: "gist", gist: "abc123def456789012345" }
test: parseUrl("https://github.com/owner/repo/tree/main/src") → { type: "repo", owner: "owner", repo: "repo", ref: "main", path: "src" }
test: parseUrl("https://github.com/owner/repo/blob/main/file.ts") → { type: "repo", owner: "owner", repo: "repo", ref: "main", path: "file.ts" }
test: parseUrl("https://github.com/owner/repo/blob/main/file.ts#L10") → { type: "repo", ..., startLine: 10, endLine: 10 }
test: parseUrl("https://github.com/owner/repo/blob/main/file.ts#L10-L20") → { type: "repo", ..., startLine: 10, endLine: 20 }
test: parseUrl("owner/repo/path") → { type: "repo-shorthand", owner: "owner", repo: "repo", path: "path" }
test: parseUrl("owner/repo/tree/main/path") → { type: "repo", owner: "owner", repo: "repo", ref: "main", path: "path" }
test: parseUrl("owner/repo/project-conventions#v1.0.0") → { type: "repo-shorthand", owner: "owner", repo: "repo", path: "project-conventions", ref: "v1.0.0" }
test: parseUrl("https://example.com/file.txt") → { type: "raw", url: "https://example.com/file.txt", filename: "file.txt" }
test: parseUrl("https://github.com/owner/repo/commit/abc123") → { type: "commit", owner: "owner", repo: "repo", sha: "abc123" }
test: parseUrl("github.com/owner/repo/commit/abc123") → { type: "commit", ... } (no protocol)
test: parseUrl("https://github.com/owner/repo/compare/v1.0...v2.0") → { type: "commit-range", base: "v1.0", head: "v2.0" }
test: parseUrl("https://github.com/owner/repo/compare/abc123...main") → { type: "commit-range", base: "abc123", head: "main" }
test: parseUrl("https://github.com/owner/repo/pull/42") → { type: "pull", owner: "owner", repo: "repo", number: 42 }
test: parseUrl("github.com/owner/repo/pull/42") → { type: "pull", ... } (no protocol)
test: parseUrl("garbage") → throws
```

### Canonical URLs

```
test: roundtrip for each source type — parseUrl(canonicalUrl(parseUrl(input))) equals parseUrl(input)
test: line range preserved in canonical URL: canonicalUrl includes #L10-L20
test: commit canonical includes full sha
test: PR canonical includes number
```

### Add: file sources

```
test: add gist — writes files, creates trackcn.json with version and hashes
test: add repo directory — writes all files recursively, tracks with commit SHA
test: add single repo file — writes one file
test: add raw URL — writes file, version is content hash
test: add with directory target — files written under specified directory
test: add with trailing / directory — derives subdirectory name from URL
test: add multiple URLs with trailing / — each gets its own subdirectory
test: add when file already exists (untracked) — skips without --force
test: add when file already exists (untracked) with --force — overwrites
test: add when file already tracked and unmodified — overwrites silently
test: add when file already tracked and modified — prepends merge markers
test: add when file content matches — updates tracking, no write
test: add --dry-run — no files written, no trackcn.json changes
test: add --json — outputs structured JSON
test: add with --post-pull — stores hook in manifest
test: add with patch files — stages to temp, reports paths
test: add with prompt files — stages to temp, reports paths
```

### Add: changeset sources

```
test: add commit — applies added files from the commit
test: add commit — applies modified files (overwrites if not locally modified)
test: add commit — merge markers when file locally modified
test: add commit — handles removed files (deletes if tracked and unmodified)
test: add commit — handles renamed files
test: add commit — skips added files that already exist without --force
test: add commit with --force — overwrites existing files
test: add commit --dry-run — shows changeset without writing
test: add commit-range — applies combined diff
test: add commit-range — resolves branch name to SHA for version
test: add pull request — resolves PR to base...head, applies diff
test: add pull request — stores head SHA as version
test: add changeset --json — outputs structured JSON with added/merged/deleted/renamed/skipped
```

### Add: line ranges

```
test: add blob URL with #L10 — extracts single line
test: add blob URL with #L10-L20 — extracts line range (inclusive)
test: add directory URL with #L10 — throws error (directories don't support line ranges)
test: line range canonical URL preserved — trackcn.json stores URL with fragment
test: pull line-range source — re-fetches and re-slices (when this is implemented)
```

### Pull: file sources

```
test: pull with no changes — "everything up to date"
test: pull repo — upstream modified file, local unmodified → overwrite
test: pull repo — upstream modified file, local modified → merge markers
test: pull repo — upstream added file → write new file
test: pull repo — upstream deleted file, local unmodified → delete
test: pull repo — upstream deleted file, local modified → skip with warning
test: pull repo — upstream renamed file → rename locally
test: pull repo — upstream renamed + modified, local modified → rename + merge markers
test: pull repo — compare API failure → falls back to full refetch
test: pull gist — upstream modified → overwrite unmodified, merge markers for modified
test: pull gist — upstream deleted file → delete if unmodified
test: pull raw URL — content changed → overwrite or merge markers
test: pull --force — overwrites locally modified files
test: pull --dry-run — no files written
test: pull --json — structured output
test: pull triggers post-pull hooks when changes occur
test: pull doesn't trigger hooks when no changes
test: pull updates version in trackcn.json
test: pull updates file hashes in trackcn.json
test: merge markers don't pile up — second pull with unresolved markers doesn't add another block
```

### Pull: changeset sources

```
test: pull commit — no-op (immutable)
test: pull commit-range with branch head — resolves new SHA, applies incremental diff
test: pull commit-range with SHA head — no-op (immutable)
test: pull PR — detects new head SHA, applies incremental diff
test: pull PR — no change when head SHA unchanged
test: pull changeset sources — same merge marker logic as file sources
```

### Status

```
test: status all up to date → exit 0
test: status upstream changed → exit 1, shows version diff
test: status locally modified file → exit 1, shows M
test: status missing file → exit 1, shows D
test: status unresolved merge markers → exit 1, shows C
test: status commit source → always up to date
test: status commit-range with branch head → resolves to check
test: status PR source → checks latest head SHA
test: status --json → structured output
test: status with multiple sources — checks all, aggregates stale/drifted
```

### Remove

```
test: remove by exact URL — removes from trackcn.json, leaves files
test: remove by partial match — substring match works
test: remove --hard — deletes tracked files from disk
test: remove non-existent source — error with list of tracked sources
test: remove --json — structured output
```

### Merge markers

```
test: prependMergeMarker adds <<<<<<< trackcn block
test: prependMergeMarker doesn't double up if markers already exist
test: hasMergeMarker detects markers
test: cleanDiff strips --- and +++ headers
test: merge markers make the file syntactically invalid (pressure to resolve)
```

### Content hashing

```
test: contentHash is deterministic — same content → same hash
test: contentHash differs for different content
test: hashes stored in trackcn.json match actual file content after add
```

### Edge cases

```
test: binary files — fetched and written as raw bytes (content that fails a utf-8 round trip stays a Buffer); hashes are computed over the raw bytes; merge markers are never applied — a binary conflict is skipped with a warning (use --force to overwrite)
test: empty files — should work (hash of empty string)
test: very large files — GitHub Contents API has a 100MB limit
test: files with merge markers from git — trackcn markers are distinct (<<<<<<< trackcn vs <<<<<<< HEAD)
test: concurrent adds to same source — last write wins for manifest
test: GITHUB_TOKEN authentication — uses token when set
test: rate limiting — shows helpful error with 403
test: 404 errors — shows "Not found" error
test: network failures — shows error, doesn't corrupt manifest
test: trackcn.json doesn't exist on pull/status/remove — helpful error message
```
