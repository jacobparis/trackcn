# trackcn

Sync files, directories, commits, and pull requests from GitHub into your codebase — and keep pulling updates as upstream changes. Think shadcn, for anything on GitHub.

```bash
npx trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
```

Everything you install is tracked in `trackcn.json` with the source URL, the upstream revision, and a content hash for every file. From then on:

```bash
trackcn status   # is upstream ahead? did I edit anything locally?
trackcn pull     # apply upstream changes, protecting local edits
```

You're expected to modify the files you install. When upstream changes a file you've also changed, `trackcn pull` doesn't clobber your version — it prepends a merge marker block containing the upstream diff:

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

The file is intentionally invalid until resolved. It's not the kind of merge conflict you solve by hand anymore — tell your agent to run `trackcn pull` and reconcile. The agent sees exactly what changed upstream, applies it to your modified version, updates any other files affected by the change, and removes the markers.

## For agents

trackcn ships a version-matched usage guide with the CLI itself:

```bash
trackcn skills get trackcn
```

Or install it as a skill so your agent knows the workflow before it ever runs a command:

```bash
trackcn add jacobparis/trackcn/trackcn-skill
```

All commands accept `--json` for structured output, and `--dry-run` to preview without writing.

## Use-cases

| | Like shadcn for... | Status |
|---|---|---|
| [Agent skills](#agent-skills) | skills | Stable |
| [Single files](#single-files) | gists | Stable |
| [Directories](#directories) | github | Stable |
| [Registry bundles](#registry-bundles) | registries | Stable |
| [Post-pull hooks](#post-pull-hooks) | icons | Stable |
| [Templates](#templates) | templates | Stable |
| [Line ranges](#line-ranges) | CSS snippets | Preview |
| [Commits](#commits) | commits | Preview |
| [Commit ranges](#commit-ranges) | features | Preview |
| [Pull requests](#pull-requests) | pull requests | Preview |

### Agent skills

Agentic best practices change with every new model. Install a shared skill library once and let every repo pull the latest guidance:

```bash
trackcn add https://github.com/mattpocock/skills/tree/main/skills ./.cursor/skills
```

Skills are just markdown files in GitHub directories — trackcn doesn't care which agent consumes them. Claude uses `./.claude/skills/`, Cursor uses `./.cursor/skills/`; track the same upstream into both, or track one and symlink the other. The project-vs-user split is just a function of where you run trackcn: run it from a repo root for project scope, from `$HOME` for user scope.

### Single files

Mirror a canonical file into every project that needs it:

```bash
trackcn add https://github.com/vercel/ai/blob/main/AGENTS.md ./AGENTS.md
```

Gists work too — `trackcn add https://gist.github.com/user/abc123` — and so does any raw `https://` URL.

### Directories

Track a maintainer-quality folder across every repository:

```bash
trackcn add https://github.com/vercel/ai/tree/main/.github/ISSUE_TEMPLATE ./.github/ISSUE_TEMPLATE
```

### Registry bundles

trackcn consumes the same repository-authored bundles as [shadcn GitHub registries](https://ui.shadcn.com/docs/registry/github). A repository adds a root `registry.json` to publish curated installable items — configs, rules, docs, templates, workflows — without inventing another catalog format.

```bash
trackcn add <owner>/<repo>              # list a repository's install options
trackcn add <owner>/<repo>/<item>       # install a curated bundle
trackcn add <owner>/<repo>/<item>#v1.0.0  # pin to a ref
```

The bundle is recorded in `trackcn.json`, so `status` and `pull` keep it current. The shadcn CLI stays compatible for one-time installs.

### Post-pull hooks

Run a command whenever a source's files change on pull. Pull SVG sources and regenerate your sprite sheet automatically:

```bash
trackcn add https://github.com/lucide-icons/lucide/tree/main/icons ./icons --post-pull "pnpm build:icons"
```

### Templates

Track a template instead of forking it. Start from an upstream example and keep improvements pullable over time:

```bash
trackcn add https://github.com/vercel/next.js/tree/canary/examples/with-sentry .
```

No special command — a template is just more files. When upstream releases new features, `trackcn pull` brings them in and your local changes are protected by merge markers.

### Line ranges

Track only the lines you need from a source file, not the whole thing:

```bash
trackcn add https://github.com/owner/repo/blob/main/styles.css#L227-L300 ./styles/prose.css
```

**Preview:** line ranges re-slice on `pull`, but are only supported on full `blob` URLs (not `owner/repo/path#L10` shorthand) and can't follow content that moves to different line numbers upstream.

### Commits

There's no point waiting for upstream to cut a release — take a commit and apply its diff directly to your project:

```bash
trackcn add https://github.com/owner/repo/commit/<sha>
```

Added files are written, modified files are overwritten or merge-marked depending on your local state, and the whole changeset is tracked in the manifest. Commits are immutable, so `pull` is a no-op.

### Commit ranges

The feature you want is usually more than one commit. Diffs are diffs — apply the delta between two revisions at once:

```bash
trackcn add https://github.com/owner/repo/compare/base...head
```

If `head` is a branch name, `trackcn pull` picks up new commits incrementally.

### Pull requests

Ship a reviewed feature twice. Prompt an agent to build a feature as a PR, get it reviewed, then apply that nicely packaged feature to your other projects instead of prompting from scratch:

```bash
trackcn add https://github.com/owner/repo/pull/42
```

`trackcn pull` detects new commits pushed to the PR and applies them incrementally.

## How it works

1. **Add upstream code.** Point at a file, directory, registry item, commit, or PR.
2. **Commit the manifest.** `trackcn.json` records the source, revision, and per-file content hashes. Every collaborator and CI run gets the same content.
3. **Pull when upstream moves.** `trackcn status` shows drift. `trackcn pull` applies the change.

For every file operation, trackcn compares three hashes — what it last wrote (stored), what's on disk now, and what upstream has:

| Stored == Disk | Upstream changed | Action |
|---|---|---|
| Yes | Yes | Overwrite (safe) |
| Yes | No | Skip (nothing changed) |
| No | No | Skip (only you changed it) |
| No | Yes | Prepend merge markers |

If the file on disk matches what trackcn last wrote, following upstream is safe. If you modified it, the file is protected. `--force` overrides, `--dry-run` previews.

## Commands

```
trackcn add <url...> [directory]     Install files from GitHub sources
trackcn pull [--dry-run] [--force]   Update installed files from their sources
trackcn status [--json]              Check if files are up to date
trackcn remove <url> [--hard]        Untrack a source (--hard deletes files)
trackcn auth [login|status|logout]   Manage GitHub login
trackcn skills [list|get|path]       Load version-matched usage guides for agents
```

See [SPEC.md](SPEC.md) for the full specification: URL formats, manifest schema, merge semantics, JSON output shapes, and recipes.

### CI gate

`trackcn status` exits 1 if any source is stale or any tracked file has drifted:

```yaml
- run: npx trackcn status
```

## Authentication

Set `GITHUB_TOKEN` (or `TRACKCN_GITHUB_TOKEN`) for authenticated GitHub API access — 5,000 requests/hour instead of 60. Required in practice for large directories and busy networks. `trackcn auth login` offers a browser login on builds configured with a GitHub App client id (`TRACKCN_GITHUB_CLIENT_ID`).

## License

MIT
