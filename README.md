# trackcn

Clone individual files and directories from various GitHub repositories into your codebase, and pull upstream changes at any time.

```bash
npx trackcn add anthropics/skills/tree/main/skills ./.claude/skills
```

That's Anthropic's skill library — updated weekly, and meant to be edited. Tune `frontend-design` to your design system; when upstream improves it, `trackcn pull` applies the upstream *diff* over your version, and collisions become merge markers your agent resolves.

## Use-cases

### Agent skills

Install a skill library once, modify the skills to fit your project, and keep pulling upstream improvements without losing your edits:

```bash
trackcn add mattpocock/skills/tree/main/skills ./.cursor/skills
```

Skills are just markdown in GitHub directories — trackcn doesn't care which agent consumes them. Claude reads `./.claude/skills/`, Cursor reads `./.cursor/skills/`; track the same upstream into both, or track one and symlink the other.

Use trackcn when you intend to **edit the skills you install** — a `design.md` you tune to your product, project best practices you extend — and still want upstream updates. Your edits are protected: updates arrive as merge markers, never overwrites. If a skill is pure documentation you'll never touch, a plain skill installer like skills.sh is all you need.

### UI components

Copy-and-own components, with the missing half — updates. shadcn's model cuts you off from upstream fixes the moment you customize a component; trackcn closes the loop:

```bash
trackcn add shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx ./components/ui/button.tsx
```

Component updates are rare but valuable — accessibility fixes and new variants land on top of your customizations instead of forcing a manual diff.

### Single files

Mirror a canonical file into every project that needs it:

```bash
trackcn add vercel/ai/blob/main/AGENTS.md ./AGENTS.md
```

Gists (`trackcn add https://gist.github.com/user/abc123`) and any raw `https://` URL work too.

### Directories

Track a maintainer-quality folder across every repository:

```bash
trackcn add vercel/ai/tree/main/.github/ISSUE_TEMPLATE ./.github/ISSUE_TEMPLATE
```

### Templates

Start from an upstream example without forking it. When upstream ships improvements, pull them into your modified copy:

```bash
trackcn add vercel/next.js/tree/canary/examples/with-sentry .
```

### Registry bundles

Repositories that publish a root [shadcn GitHub registry](https://ui.shadcn.com/docs/registry/github) `registry.json` expose curated installable items — configs, rules, docs, workflows:

```bash
trackcn add acme/toolkit                    # list a repository's install options
trackcn add acme/toolkit/project-conventions
trackcn add acme/toolkit/project-conventions#v1.0.0
```

### Post-pull hooks

Run a command whenever a source's files change on pull — pull SVG icons and regenerate your sprite sheet automatically:

```bash
trackcn add lucide-icons/lucide/tree/main/icons ./icons --post-pull "pnpm build:icons"
```

### Line ranges

Track only the lines you need from a source file:

```bash
trackcn add owner/repo/blob/main/styles.css#L227-L300 ./styles/prose.css
```

**Preview:** ranges re-slice on pull but are positional — they can't follow content that moves upstream.

### Commits, commit ranges, and pull requests

Diffs are diffs. Apply a changeset directly instead of waiting for a release, or ship a reviewed feature twice — build it as a PR in one repo, apply it to the next:

```bash
trackcn add owner/repo/commit/abc1234              # one commit's changes
trackcn add owner/repo/compare/v1.0...v2.0         # everything between two revisions
trackcn add owner/repo/pull/42                     # a PR's changes; pull picks up new commits
```

**Preview:** commits are immutable (`pull` is a no-op); branch-head ranges and PRs update incrementally.

## How it works

Everything you install is recorded in `trackcn.json` — committed to your repo, so every collaborator and CI run gets the same content:

- Each tracked file and directory is marked with the upstream commit SHA it came from, plus a content hash of what was written.
- `trackcn pull` computes the upstream diff from the point you diverged to the latest upstream, then applies that diff over your code — not the upstream contents.
- Where the diff collides with your local edits, trackcn prepends a merge-marker block containing the upstream diff:

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

The file is intentionally invalid until resolved — but this isn't the kind of conflict you solve by hand anymore. The block is the pure upstream diff and the code below it is yours, so tell your agent to run `trackcn pull` and reconcile: it applies the upstream change to your version and removes the markers.

If a file on disk still matches what trackcn last wrote, upstream changes apply cleanly and silently. If you modified it, it's protected — markers, never overwrites. `--force` overrides, `--dry-run` previews. See [SPEC.md](SPEC.md) for the full merge semantics.

## For agents

trackcn ships a version-matched usage guide with the CLI:

```bash
trackcn skills get trackcn
```

Or install it as a skill so your agent knows the workflow before it ever runs a command:

```bash
trackcn add jacobparis/trackcn/trackcn-skill
```

All commands accept `--json` for structured output.

## Commands

```
trackcn add <url...> [directory]     Install files from GitHub sources
trackcn pull [--dry-run] [--force]   Update installed files from their sources
trackcn status [--json]              Check if files are up to date
trackcn remove <url> [--hard]        Untrack a source (--hard deletes files)
trackcn auth [login|status|logout]   Manage GitHub login
trackcn skills [list|get|path]       Load version-matched usage guides for agents
```

Shorthands like `owner/repo/tree/ref/path` and full `https://github.com/...` URLs are interchangeable.

### CI gate

`trackcn status` exits 1 if any source is stale or any tracked file has drifted:

```yaml
- run: npx trackcn status
```

## Authentication

Set `GITHUB_TOKEN` (or `TRACKCN_GITHUB_TOKEN`) for authenticated GitHub API access — 5,000 requests/hour instead of 60. Required in practice for large directories and busy networks.

## License

MIT
