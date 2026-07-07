import { createHash } from 'crypto';
import { basename } from 'path';
import { structuredPatch } from 'diff';

// ============================================================================
// File Processing
// ============================================================================

export type FileType = 'regular' | 'patch' | 'prompt';

// Text files travel as strings; binary files (images, archives) travel as
// Buffers so their bytes are written and hashed verbatim.
export type FileContent = string | Buffer;

export interface SourceFile {
  filename: string;
  content: FileContent;
  type: FileType;
  target: string;
  patchOrder?: number;
}

export function categorizeFile(filename: string): FileType {
  if (filename.endsWith('.prompt.md')) return 'prompt';
  if (basename(filename).match(/^\d+_.+\.patch$/)) return 'patch';
  return 'regular';
}

export function getPatchOrder(filename: string): number {
  const match = basename(filename).match(/^(\d+)_/);
  return match ? parseInt(match[1], 10) : 0;
}

// Hashing a Buffer of UTF-8 bytes and hashing the equivalent string produce
// the same digest, so hashes recorded before binary support remain valid.
export function contentHash(content: FileContent): string {
  return createHash('sha256').update(content).digest('hex');
}

// Fetched bytes are text only if they survive a UTF-8 round trip; anything
// else (PNG magic bytes, NUL-laden data) stays a Buffer.
export function decodeFetchedContent(buf: Buffer): FileContent {
  const text = buf.toString('utf-8');
  return Buffer.from(text, 'utf-8').equals(buf) ? text : buf;
}

// Returns the content as a string when it is (or decodes losslessly to)
// text, or null for binary content that must not go through text merges.
export function asText(content: FileContent): string | null {
  if (typeof content === 'string') return content;
  const decoded = decodeFetchedContent(content);
  return typeof decoded === 'string' ? decoded : null;
}

export function decodeGistFilename(filename: string): string {
  const patchMatch = filename.match(/^\d+_(.+)\.patch$/);
  if (patchMatch) return decodeGistFilename(patchMatch[1]);
  return filename.replace(/_/g, '/');
}

export function sortFiles(files: SourceFile[]): SourceFile[] {
  return [...files].sort((a, b) => {
    const typeOrder = { regular: 0, patch: 1, prompt: 2 };
    if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
    if (a.type === 'patch' && b.type === 'patch') return (a.patchOrder || 0) - (b.patchOrder || 0);
    return 0;
  });
}

// ============================================================================
// Merge Markers
// ============================================================================

export const MERGE_START = '<<<<<<< trackcn';
export const MERGE_END = '>>>>>>> trackcn';

export function hasMergeMarker(content: string): boolean {
  return content.includes(MERGE_START);
}

// Strips only the ---/+++ file-header lines that precede the first hunk.
// Removed content lines inside hunks can also start with `---` (SQL comments,
// decrement expressions) and must survive.
export function cleanDiff(diff: string): string {
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const headerEnd = firstHunk === -1 ? lines.length : firstHunk;
  const header = lines.slice(0, headerEnd).filter((line) =>
    !line.startsWith('---') && !line.startsWith('+++')
  );
  return [...header, ...lines.slice(headerEnd)].join('\n');
}

// Unified-diff hunks (no ---/+++ file headers), computed in-process so the
// output is identical on every platform.
export function unifiedDiff(oldText: string, newText: string): string {
  const patch = structuredPatch('old', 'new', oldText, newText, undefined, undefined, { context: 3 });
  const out: string[] = [];
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    out.push(...hunk.lines);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export function prependMergeMarker(content: string, diff: string): string {
  if (hasMergeMarker(content)) return content;
  return `${MERGE_START}\n${cleanDiff(diff).trimEnd()}\n${MERGE_END}\n${content}`;
}

// Adds a marker block for a NEW upstream change even when an unresolved block
// from an earlier change is still present — each distinct upstream delta is
// preserved as its own stacked block. Re-offering the same diff is a no-op so
// repeated pulls never pile up duplicates.
export function addMergeMarker(content: string, diff: string): { content: string; added: boolean } {
  const block = `${MERGE_START}\n${cleanDiff(diff).trimEnd()}\n${MERGE_END}\n`;
  if (content.includes(block)) return { content, added: false };
  return { content: block + content, added: true };
}

// ============================================================================
// Source Parsing & Canonical URLs
// ============================================================================

export interface MarkdownSectionRef { level: number; heading: string; raw: string }
export interface ParsedGist { type: 'gist'; gist: string; filename?: string; markdownSection?: MarkdownSectionRef }
export interface ParsedRepo { type: 'repo'; owner: string; repo: string; path: string; ref: string; startLine?: number; endLine?: number; markdownSection?: MarkdownSectionRef }
export interface ParsedRepoShorthand { type: 'repo-shorthand'; owner: string; repo: string; path: string; ref?: string; markdownSection?: MarkdownSectionRef }
export interface ParsedRaw { type: 'raw'; url: string; filename: string }
export interface ParsedCommit { type: 'commit'; owner: string; repo: string; sha: string }
export interface ParsedCommitRange { type: 'commit-range'; owner: string; repo: string; base: string; head: string }
export interface ParsedPull { type: 'pull'; owner: string; repo: string; number: number }
export type ParsedSource = ParsedGist | ParsedRepo | ParsedRepoShorthand | ParsedRaw | ParsedCommit | ParsedCommitRange | ParsedPull;

export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx)$/i.test(path);
}

export function normalizeMarkdownHeading(value: string): string {
  return value
    .trim()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function parseMarkdownSectionFragment(fragment: string): MarkdownSectionRef | null {
  const match = fragment.match(/^(#{1,6})([^#].*)$/);
  if (!match) return null;
  const heading = normalizeMarkdownHeading(decodeURIComponent(match[2]));
  if (!heading) return null;
  return { level: match[1].length, heading, raw: `${match[1]}${heading}` };
}

function parseGistFragment(fragment: string): Pick<ParsedGist, 'filename' | 'markdownSection'> {
  const filenameMatch = fragment.match(/^#(.+?\.(?:md|mdx))(#{1,6}[^#].*)$/i);
  if (filenameMatch) {
    const filename = decodeURIComponent(filenameMatch[1]);
    const section = parseMarkdownSectionFragment(filenameMatch[2]);
    return section ? { filename, markdownSection: section } : {};
  }

  const markdownSection = parseMarkdownSectionFragment(fragment);
  return markdownSection ? { markdownSection } : {};
}

export function parseUrl(input: string): ParsedSource {
  let inputFragment = '';
  let inputWithoutFragment = input;
  const inputFragmentIdx = input.indexOf('#');
  if (inputFragmentIdx !== -1) {
    inputFragment = input.slice(inputFragmentIdx);
    inputWithoutFragment = input.slice(0, inputFragmentIdx);
  }

  if (inputWithoutFragment.includes('gist.github.com')) {
    const match = inputWithoutFragment.match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
    if (match) return { type: 'gist', gist: match[1], ...parseGistFragment(inputFragment) };
  }
  if (/^[a-f0-9]{20,}$/i.test(inputWithoutFragment)) {
    return { type: 'gist', gist: inputWithoutFragment, ...parseGistFragment(inputFragment) };
  }

  // Expand owner/repo/<github-route>/... shorthand before matching full URLs.
  const githubInput = /^(?:https?:\/\/)?github\.com\//.test(input)
    ? input
    : `github.com/${input}`;

  // Commit URL: github.com/owner/repo/commit/sha
  const commitMatch = githubInput.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)/i
  );
  if (commitMatch) {
    return { type: 'commit', owner: commitMatch[1], repo: commitMatch[2], sha: commitMatch[3] };
  }

  // Compare URL: github.com/owner/repo/compare/base...head
  const compareMatch = githubInput.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/compare\/(.+?)\.\.\.(.+)/
  );
  if (compareMatch) {
    return { type: 'commit-range', owner: compareMatch[1], repo: compareMatch[2], base: compareMatch[3], head: compareMatch[4] };
  }

  // Pull request URL: github.com/owner/repo/pull/123
  const pullMatch = githubInput.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (pullMatch) {
    return { type: 'pull', owner: pullMatch[1], repo: pullMatch[2], number: parseInt(pullMatch[3], 10) };
  }

  // Strip fragment (#L10-L20) before repo matching
  let fragment = '';
  let cleanInput = input;
  const fragmentIdx = input.indexOf('#');
  if (fragmentIdx !== -1) {
    fragment = input.slice(fragmentIdx);
    cleanInput = input.slice(0, fragmentIdx);
  }

  const explicitRepoInput = /^(?:https?:\/\/)?github\.com\//.test(cleanInput)
    ? cleanInput
    : `github.com/${cleanInput}`;
  const repoMatch = explicitRepoInput.match(
    /(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.+))?/
  );
  if (repoMatch) {
    const parsed: ParsedRepo = { type: 'repo', owner: repoMatch[1], repo: repoMatch[2], ref: repoMatch[3], path: repoMatch[4] || '' };
    const lineMatch = fragment.match(/^#L(\d+)(?:-L(\d+))?$/);
    const markdownSection = isMarkdownPath(parsed.path) ? parseMarkdownSectionFragment(fragment) : null;
    if (lineMatch) {
      parsed.startLine = parseInt(lineMatch[1], 10);
      parsed.endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : parsed.startLine;
    } else if (markdownSection) {
      parsed.markdownSection = markdownSection;
    } else if (fragment) {
      // GitHub route URLs cannot unambiguously split a branch containing `/`
      // from the repository path. An explicit fragment selects that ref.
      parsed.ref = fragment.slice(1).replace(/^ref=/, '');
    }
    return parsed;
  }

  const githubRootMatch = cleanInput.match(
    /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/?$/
  );
  if (githubRootMatch) {
    return {
      type: 'repo-shorthand',
      owner: githubRootMatch[1],
      repo: githubRootMatch[2],
      path: '',
      ...(fragment && !fragment.match(/^#L\d/) ? { ref: fragment.slice(1) } : {}),
    };
  }

  // Raw URL: any https:// URL that isn't a recognized GitHub route (single file fetch)
  if (cleanInput.startsWith('https://') || cleanInput.startsWith('http://')) {
    const filename = cleanInput.split('/').pop() || 'file';
    return { type: 'raw', url: cleanInput, filename };
  }

  const shortMatch = cleanInput.match(/^([^/]+)\/([^/]+)(?:\/(.+))?$/);
  if (shortMatch) {
    return {
      type: 'repo-shorthand',
      owner: shortMatch[1],
      repo: shortMatch[2],
      path: shortMatch[3] || '',
      ...(isMarkdownPath(shortMatch[3] || '') && parseMarkdownSectionFragment(fragment)
        ? { markdownSection: parseMarkdownSectionFragment(fragment)! }
        : fragment && !fragment.match(/^#L\d/) ? { ref: fragment.slice(1) } : {}),
    };
  }

  throw new Error(`Cannot parse URL: ${input}\nExpected a gist URL, repo URL, raw URL, or owner/repo/path`);
}

export function canonicalUrl(parsed: ParsedSource): string {
  if (parsed.type === 'gist') {
    const fragment = parsed.markdownSection
      ? `${parsed.filename ? `#${encodeURIComponent(parsed.filename)}` : ''}${parsed.markdownSection.raw}`
      : '';
    return `https://gist.github.com/${parsed.gist}${fragment}`;
  }
  if (parsed.type === 'raw') return parsed.url;
  if (parsed.type === 'commit') return `https://github.com/${parsed.owner}/${parsed.repo}/commit/${parsed.sha}`;
  if (parsed.type === 'commit-range') return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${parsed.base}...${parsed.head}`;
  if (parsed.type === 'pull') return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  if (parsed.type === 'repo-shorthand') {
    const fragment = parsed.markdownSection ? parsed.markdownSection.raw : parsed.ref ? `#${parsed.ref}` : '';
    return `${parsed.owner}/${parsed.repo}${parsed.path ? `/${parsed.path}` : ''}${fragment}`;
  }
  const pathPart = parsed.path ? `/${parsed.path}` : '';
  const linePart = parsed.startLine
    ? (parsed.endLine && parsed.endLine !== parsed.startLine ? `#L${parsed.startLine}-L${parsed.endLine}` : `#L${parsed.startLine}`)
    : '';
  const sectionPart = parsed.markdownSection ? parsed.markdownSection.raw : '';
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${parsed.ref}${pathPart}${linePart || sectionPart}`;
}

export function isLocalPath(a: string): boolean {
  return a === '.' || a.startsWith('./') || a.startsWith('/');
}

export function lastPathSegment(parsed: ParsedSource): string {
  if (parsed.type === 'gist') return parsed.gist;
  if (parsed.type === 'raw') {
    try {
      return new URL(parsed.url).hostname;
    } catch {
      return parsed.filename;
    }
  }
  if (parsed.type === 'commit') return parsed.sha.slice(0, 8);
  if (parsed.type === 'commit-range') return `${parsed.base.slice(0, 8)}-${parsed.head.slice(0, 8)}`;
  if (parsed.type === 'pull') return `pr-${parsed.number}`;
  if (parsed.type === 'repo-shorthand') return parsed.path.split('/').pop() || parsed.repo;
  return parsed.path.split('/').pop() || parsed.repo;
}
