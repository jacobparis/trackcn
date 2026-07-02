import { createHash } from 'crypto';
import { basename } from 'path';

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

export function cleanDiff(diff: string): string {
  return diff.split('\n').filter((line) =>
    !line.startsWith('---') && !line.startsWith('+++')
  ).join('\n');
}

export function prependMergeMarker(content: string, diff: string): string {
  if (hasMergeMarker(content)) return content;
  return `${MERGE_START}\n${cleanDiff(diff).trimEnd()}\n${MERGE_END}\n${content}`;
}

// ============================================================================
// Source Parsing & Canonical URLs
// ============================================================================

export interface ParsedGist { type: 'gist'; gist: string }
export interface ParsedRepo { type: 'repo'; owner: string; repo: string; path: string; ref: string; startLine?: number; endLine?: number }
export interface ParsedRepoShorthand { type: 'repo-shorthand'; owner: string; repo: string; path: string; ref?: string }
export interface ParsedRaw { type: 'raw'; url: string; filename: string }
export interface ParsedCommit { type: 'commit'; owner: string; repo: string; sha: string }
export interface ParsedCommitRange { type: 'commit-range'; owner: string; repo: string; base: string; head: string }
export interface ParsedPull { type: 'pull'; owner: string; repo: string; number: number }
export type ParsedSource = ParsedGist | ParsedRepo | ParsedRepoShorthand | ParsedRaw | ParsedCommit | ParsedCommitRange | ParsedPull;

export function parseUrl(input: string): ParsedSource {
  if (input.includes('gist.github.com')) {
    const match = input.match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
    if (match) return { type: 'gist', gist: match[1] };
  }
  if (/^[a-f0-9]{20,}$/i.test(input)) {
    return { type: 'gist', gist: input };
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
    if (lineMatch) {
      parsed.startLine = parseInt(lineMatch[1], 10);
      parsed.endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : parsed.startLine;
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
      ...(fragment && !fragment.match(/^#L\d/) ? { ref: fragment.slice(1) } : {}),
    };
  }

  throw new Error(`Cannot parse URL: ${input}\nExpected a gist URL, repo URL, raw URL, or owner/repo/path`);
}

export function canonicalUrl(parsed: ParsedSource): string {
  if (parsed.type === 'gist') return `https://gist.github.com/${parsed.gist}`;
  if (parsed.type === 'raw') return parsed.url;
  if (parsed.type === 'commit') return `https://github.com/${parsed.owner}/${parsed.repo}/commit/${parsed.sha}`;
  if (parsed.type === 'commit-range') return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${parsed.base}...${parsed.head}`;
  if (parsed.type === 'pull') return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
  if (parsed.type === 'repo-shorthand') {
    return `${parsed.owner}/${parsed.repo}${parsed.path ? `/${parsed.path}` : ''}${parsed.ref ? `#${parsed.ref}` : ''}`;
  }
  const pathPart = parsed.path ? `/${parsed.path}` : '';
  const linePart = parsed.startLine
    ? (parsed.endLine && parsed.endLine !== parsed.startLine ? `#L${parsed.startLine}-L${parsed.endLine}` : `#L${parsed.startLine}`)
    : '';
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${parsed.ref}${pathPart}${linePart}`;
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
