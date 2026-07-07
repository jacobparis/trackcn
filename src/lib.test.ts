import { describe, it, expect } from 'vitest';
import {
  parseUrl, canonicalUrl, contentHash, isLocalPath, lastPathSegment,
  hasMergeMarker, cleanDiff, prependMergeMarker, addMergeMarker, unifiedDiff, MERGE_START, MERGE_END,
  categorizeFile, decodeGistFilename, sortFiles, getPatchOrder,
  type ParsedSource, type ParsedRepo, type SourceFile,
} from './lib.js';

// ============================================================================
// parseUrl
// ============================================================================

describe('parseUrl', () => {
  describe('gists', () => {
    it('parses gist URL with username', () => {
      const result = parseUrl('https://gist.github.com/user/abc123');
      expect(result).toEqual({ type: 'gist', gist: 'abc123' });
    });

    it('parses gist URL without username', () => {
      const result = parseUrl('https://gist.github.com/abc123');
      expect(result).toEqual({ type: 'gist', gist: 'abc123' });
    });

    it('parses bare hex ID (20+ chars)', () => {
      const id = 'abc123def456789012345';
      const result = parseUrl(id);
      expect(result).toEqual({ type: 'gist', gist: id });
    });

    it('parses a single-file gist markdown heading fragment', () => {
      const result = parseUrl('https://gist.github.com/user/abc123def456789012345##Installation');
      expect(result).toEqual({
        type: 'gist',
        gist: 'abc123def456789012345',
        markdownSection: { level: 2, heading: 'installation', raw: '##installation' },
      });
    });

    it('parses a filename-qualified gist markdown heading fragment', () => {
      const result = parseUrl('https://gist.github.com/user/abc123def456789012345#AGENTS.md##Installation');
      expect(result).toEqual({
        type: 'gist',
        gist: 'abc123def456789012345',
        filename: 'AGENTS.md',
        markdownSection: { level: 2, heading: 'installation', raw: '##installation' },
      });
    });

    it('does not treat short hex strings as gists', () => {
      expect(() => parseUrl('abc123')).toThrow();
    });
  });

  describe('commits', () => {
    it('parses commit URL with https', () => {
      const result = parseUrl('https://github.com/owner/repo/commit/abc123def456');
      expect(result).toEqual({ type: 'commit', owner: 'owner', repo: 'repo', sha: 'abc123def456' });
    });

    it('parses commit URL without protocol', () => {
      const result = parseUrl('github.com/owner/repo/commit/abc123def456');
      expect(result).toEqual({ type: 'commit', owner: 'owner', repo: 'repo', sha: 'abc123def456' });
    });

    it('parses commit shorthand', () => {
      const result = parseUrl('owner/repo/commit/abc123def456');
      expect(result).toEqual({ type: 'commit', owner: 'owner', repo: 'repo', sha: 'abc123def456' });
    });
  });

  describe('commit ranges', () => {
    it('parses compare URL with tags', () => {
      const result = parseUrl('https://github.com/owner/repo/compare/v1.0...v2.0');
      expect(result).toEqual({ type: 'commit-range', owner: 'owner', repo: 'repo', base: 'v1.0', head: 'v2.0' });
    });

    it('parses compare URL with SHA...branch', () => {
      const result = parseUrl('https://github.com/owner/repo/compare/abc123...main');
      expect(result).toEqual({ type: 'commit-range', owner: 'owner', repo: 'repo', base: 'abc123', head: 'main' });
    });

    it('parses compare URL without protocol', () => {
      const result = parseUrl('github.com/owner/repo/compare/abc123...def456');
      expect(result).toEqual({ type: 'commit-range', owner: 'owner', repo: 'repo', base: 'abc123', head: 'def456' });
    });

    it('parses compare shorthand', () => {
      const result = parseUrl('owner/repo/compare/abc123...main');
      expect(result).toEqual({ type: 'commit-range', owner: 'owner', repo: 'repo', base: 'abc123', head: 'main' });
    });
  });

  describe('pull requests', () => {
    it('parses PR URL with https', () => {
      const result = parseUrl('https://github.com/owner/repo/pull/42');
      expect(result).toEqual({ type: 'pull', owner: 'owner', repo: 'repo', number: 42 });
    });

    it('parses PR URL without protocol', () => {
      const result = parseUrl('github.com/owner/repo/pull/123');
      expect(result).toEqual({ type: 'pull', owner: 'owner', repo: 'repo', number: 123 });
    });

    it('parses PR shorthand', () => {
      const result = parseUrl('owner/repo/pull/123');
      expect(result).toEqual({ type: 'pull', owner: 'owner', repo: 'repo', number: 123 });
    });
  });

  describe('repos', () => {
    it('parses tree URL (directory)', () => {
      const result = parseUrl('https://github.com/owner/repo/tree/main/src');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: 'src' });
    });

    it('parses blob URL (file)', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/file.ts');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: 'file.ts' });
    });

    it('parses tree URL with nested path', () => {
      const result = parseUrl('https://github.com/owner/repo/tree/main/src/components/ui');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: 'src/components/ui' });
    });

    it('supports an explicit ref fragment for branch names containing slashes', () => {
      const result = parseUrl('https://github.com/owner/repo/tree/feature/src/rules#feature/my-branch');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'feature/my-branch', path: 'src/rules' });
    });

    it('parses tree URL with no path', () => {
      const result = parseUrl('https://github.com/owner/repo/tree/main');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: '' });
    });

    it('parses shorthand owner/repo/path', () => {
      const result = parseUrl('owner/repo/path/to/dir');
      expect(result).toEqual({ type: 'repo-shorthand', owner: 'owner', repo: 'repo', path: 'path/to/dir' });
    });

    it('parses shorthand owner/repo (no path)', () => {
      const result = parseUrl('owner/repo');
      expect(result).toEqual({ type: 'repo-shorthand', owner: 'owner', repo: 'repo', path: '' });
    });

    it('parses shorthand with a registry ref', () => {
      const result = parseUrl('owner/repo/project-conventions#feature/rules');
      expect(result).toEqual({
        type: 'repo-shorthand',
        owner: 'owner',
        repo: 'repo',
        path: 'project-conventions',
        ref: 'feature/rules',
      });
    });

    it('parses tree shorthand', () => {
      const result = parseUrl('owner/repo/tree/main/rules');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: 'rules' });
    });

    it('parses blob shorthand', () => {
      const result = parseUrl('owner/repo/blob/main/AGENTS.md');
      expect(result).toEqual({ type: 'repo', owner: 'owner', repo: 'repo', ref: 'main', path: 'AGENTS.md' });
    });
  });

  describe('line ranges', () => {
    it('parses single line #L10', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/file.ts#L10') as ParsedRepo;
      expect(result.type).toBe('repo');
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(10);
    });

    it('parses line range #L10-L20', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/file.ts#L10-L20') as ParsedRepo;
      expect(result.type).toBe('repo');
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(20);
      expect(result.path).toBe('file.ts');
    });

    it('does not add line range when no fragment', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/file.ts') as ParsedRepo;
      expect(result.startLine).toBeUndefined();
      expect(result.endLine).toBeUndefined();
    });

    it('ignores invalid fragments', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/file.ts#section') as ParsedRepo;
      expect(result.startLine).toBeUndefined();
    });
  });

  describe('markdown heading ranges', () => {
    it('parses an exact markdown heading fragment on GitHub markdown files', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/AGENTS.md##Installation') as ParsedRepo;
      expect(result.type).toBe('repo');
      expect(result.path).toBe('AGENTS.md');
      expect(result.markdownSection).toEqual({ level: 2, heading: 'installation', raw: '##installation' });
    });

    it('normalizes markdown heading fragments to lowercase kebabs', () => {
      const result = parseUrl('https://github.com/owner/repo/blob/main/AGENTS.md##Installation%20Steps') as ParsedRepo;
      expect(result.markdownSection).toEqual({ level: 2, heading: 'installation-steps', raw: '##installation-steps' });
    });

    it('parses markdown heading fragments on shorthand markdown paths', () => {
      const result = parseUrl('owner/repo/AGENTS.md###Testing');
      expect(result).toEqual({
        type: 'repo-shorthand',
        owner: 'owner',
        repo: 'repo',
        path: 'AGENTS.md',
        markdownSection: { level: 3, heading: 'testing', raw: '###testing' },
      });
    });
  });

  describe('raw URLs', () => {
    it('parses non-GitHub https URL', () => {
      const result = parseUrl('https://example.com/file.txt');
      expect(result).toEqual({ type: 'raw', url: 'https://example.com/file.txt', filename: 'file.txt' });
    });

    it('parses http URL', () => {
      const result = parseUrl('http://example.com/data.json');
      expect(result).toEqual({ type: 'raw', url: 'http://example.com/data.json', filename: 'data.json' });
    });
  });

  describe('errors', () => {
    it('throws on unparseable input', () => {
      expect(() => parseUrl('garbage')).toThrow('Cannot parse URL');
    });
  });
});

// ============================================================================
// canonicalUrl
// ============================================================================

describe('canonicalUrl', () => {
  it('gist', () => {
    expect(canonicalUrl({ type: 'gist', gist: 'abc123' })).toBe('https://gist.github.com/abc123');
  });

  it('gist with markdown heading range', () => {
    expect(canonicalUrl({ type: 'gist', gist: 'abc123', filename: 'AGENTS.md', markdownSection: { level: 2, heading: 'install', raw: '##install' } }))
      .toBe('https://gist.github.com/abc123#AGENTS.md##install');
  });

  it('raw', () => {
    expect(canonicalUrl({ type: 'raw', url: 'https://example.com/file.txt', filename: 'file.txt' }))
      .toBe('https://example.com/file.txt');
  });

  it('commit', () => {
    expect(canonicalUrl({ type: 'commit', owner: 'o', repo: 'r', sha: 'abc123' }))
      .toBe('https://github.com/o/r/commit/abc123');
  });

  it('commit-range', () => {
    expect(canonicalUrl({ type: 'commit-range', owner: 'o', repo: 'r', base: 'v1', head: 'v2' }))
      .toBe('https://github.com/o/r/compare/v1...v2');
  });

  it('pull', () => {
    expect(canonicalUrl({ type: 'pull', owner: 'o', repo: 'r', number: 42 }))
      .toBe('https://github.com/o/r/pull/42');
  });

  it('repo without line range', () => {
    expect(canonicalUrl({ type: 'repo', owner: 'o', repo: 'r', ref: 'main', path: 'src' }))
      .toBe('https://github.com/o/r/tree/main/src');
  });

  it('repo with line range', () => {
    expect(canonicalUrl({ type: 'repo', owner: 'o', repo: 'r', ref: 'main', path: 'f.ts', startLine: 10, endLine: 20 }))
      .toBe('https://github.com/o/r/tree/main/f.ts#L10-L20');
  });

  it('repo with single line', () => {
    expect(canonicalUrl({ type: 'repo', owner: 'o', repo: 'r', ref: 'main', path: 'f.ts', startLine: 10, endLine: 10 }))
      .toBe('https://github.com/o/r/tree/main/f.ts#L10');
  });

  it('repo with markdown heading range', () => {
    expect(canonicalUrl({ type: 'repo', owner: 'o', repo: 'r', ref: 'main', path: 'AGENTS.md', markdownSection: { level: 2, heading: 'install', raw: '##install' } }))
      .toBe('https://github.com/o/r/tree/main/AGENTS.md##install');
  });

  it('repo shorthand', () => {
    expect(canonicalUrl({ type: 'repo-shorthand', owner: 'o', repo: 'r', path: 'rules' }))
      .toBe('o/r/rules');
  });

  it('repo shorthand with ref', () => {
    expect(canonicalUrl({ type: 'repo-shorthand', owner: 'o', repo: 'r', path: 'rules', ref: 'v1.0.0' }))
      .toBe('o/r/rules#v1.0.0');
  });

  it('roundtrips through parseUrl for all types', () => {
    const inputs = [
      'https://gist.github.com/abc123',
      'https://github.com/o/r/commit/abc123def456',
      'https://github.com/o/r/compare/v1...v2',
      'https://github.com/o/r/pull/42',
      'https://github.com/o/r/tree/main/src',
      'https://example.com/file.txt',
    ];
    for (const input of inputs) {
      const parsed = parseUrl(input);
      const canonical = canonicalUrl(parsed);
      const reparsed = parseUrl(canonical);
      expect(reparsed).toEqual(parsed);
    }
  });
});

// ============================================================================
// lastPathSegment
// ============================================================================

describe('lastPathSegment', () => {
  it('gist returns gist ID', () => {
    expect(lastPathSegment({ type: 'gist', gist: 'abc123' })).toBe('abc123');
  });

  it('raw URL returns hostname', () => {
    expect(lastPathSegment({ type: 'raw', url: 'https://example.com/file.txt', filename: 'file.txt' }))
      .toBe('example.com');
  });

  it('commit returns short SHA', () => {
    expect(lastPathSegment({ type: 'commit', owner: 'o', repo: 'r', sha: 'abc123def456' }))
      .toBe('abc123de');
  });

  it('commit-range returns base-head', () => {
    expect(lastPathSegment({ type: 'commit-range', owner: 'o', repo: 'r', base: 'abc123def456', head: 'def456abc123' }))
      .toBe('abc123de-def456ab');
  });

  it('pull returns pr-N', () => {
    expect(lastPathSegment({ type: 'pull', owner: 'o', repo: 'r', number: 42 }))
      .toBe('pr-42');
  });

  it('repo returns last path segment', () => {
    expect(lastPathSegment({ type: 'repo', owner: 'o', repo: 'r', ref: 'main', path: 'src/components' }))
      .toBe('components');
  });

  it('repo with no path returns repo name', () => {
    expect(lastPathSegment({ type: 'repo', owner: 'o', repo: 'myrepo', ref: 'main', path: '' }))
      .toBe('myrepo');
  });
});

// ============================================================================
// isLocalPath
// ============================================================================

describe('isLocalPath', () => {
  it('"." is local', () => expect(isLocalPath('.')).toBe(true));
  it('"./dir" is local', () => expect(isLocalPath('./dir')).toBe(true));
  it('"/abs/path" is local', () => expect(isLocalPath('/abs/path')).toBe(true));
  it('"owner/repo" is not local', () => expect(isLocalPath('owner/repo')).toBe(false));
  it('URL is not local', () => expect(isLocalPath('https://example.com')).toBe(false));
});

// ============================================================================
// contentHash
// ============================================================================

describe('contentHash', () => {
  it('is deterministic', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('differs for different content', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('handles empty string', () => {
    const hash = contentHash('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ============================================================================
// Merge Markers
// ============================================================================

describe('merge markers', () => {
  describe('hasMergeMarker', () => {
    it('detects markers', () => {
      expect(hasMergeMarker(`${MERGE_START}\nsome diff\n${MERGE_END}\ncode`)).toBe(true);
    });

    it('returns false when no markers', () => {
      expect(hasMergeMarker('just regular code')).toBe(false);
    });

    it('does not confuse with git markers', () => {
      expect(hasMergeMarker('<<<<<<< HEAD\ncode\n>>>>>>> branch')).toBe(false);
    });
  });

  describe('cleanDiff', () => {
    it('strips --- and +++ lines', () => {
      const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,5 @@\n line1\n+line2';
      expect(cleanDiff(diff)).toBe('@@ -1,3 +1,5 @@\n line1\n+line2');
    });

    it('leaves other lines intact', () => {
      const diff = '@@ -1 +1 @@\n-old\n+new';
      expect(cleanDiff(diff)).toBe(diff);
    });
  });

  describe('prependMergeMarker', () => {
    it('prepends marker block', () => {
      const result = prependMergeMarker('existing code', '@@ -1 +1 @@\n-old\n+new');
      expect(result).toContain(MERGE_START);
      expect(result).toContain(MERGE_END);
      expect(result).toContain('existing code');
      expect(result.indexOf(MERGE_START)).toBeLessThan(result.indexOf('existing code'));
    });

    it('does not double up markers', () => {
      const first = prependMergeMarker('code', 'diff1');
      const second = prependMergeMarker(first, 'diff2');
      expect(second).toBe(first);
    });

    it('strips --- and +++ from the diff', () => {
      const result = prependMergeMarker('code', '--- a/f\n+++ b/f\n@@ @@\n+new');
      expect(result).not.toContain('--- a/f');
      expect(result).toContain('@@ @@');
    });
  });
});

// ============================================================================
// File Processing
// ============================================================================

describe('categorizeFile', () => {
  it('regular files', () => {
    expect(categorizeFile('utils.ts')).toBe('regular');
    expect(categorizeFile('src/index.js')).toBe('regular');
  });

  it('patch files', () => {
    expect(categorizeFile('001_package.json.patch')).toBe('patch');
    expect(categorizeFile('010_tsconfig.json.patch')).toBe('patch');
  });

  it('prompt files', () => {
    expect(categorizeFile('setup.prompt.md')).toBe('prompt');
    expect(categorizeFile('dir/install.prompt.md')).toBe('prompt');
  });
});

describe('getPatchOrder', () => {
  it('extracts number prefix', () => {
    expect(getPatchOrder('001_package.json.patch')).toBe(1);
    expect(getPatchOrder('010_tsconfig.json.patch')).toBe(10);
  });

  it('returns 0 for non-patch files', () => {
    expect(getPatchOrder('utils.ts')).toBe(0);
  });
});

describe('decodeGistFilename', () => {
  it('replaces underscores with slashes', () => {
    expect(decodeGistFilename('app_api_route.ts')).toBe('app/api/route.ts');
  });

  it('handles patch filenames', () => {
    expect(decodeGistFilename('001_package.json.patch')).toBe('package.json');
  });

  it('leaves normal filenames alone', () => {
    expect(decodeGistFilename('file.ts')).toBe('file.ts');
  });
});

describe('sortFiles', () => {
  it('sorts regular before patch before prompt', () => {
    const files: SourceFile[] = [
      { filename: 'p.prompt.md', content: '', type: 'prompt', target: 'p.prompt.md' },
      { filename: '001_x.patch', content: '', type: 'patch', target: 'x', patchOrder: 1 },
      { filename: 'a.ts', content: '', type: 'regular', target: 'a.ts' },
    ];
    const sorted = sortFiles(files);
    expect(sorted[0].type).toBe('regular');
    expect(sorted[1].type).toBe('patch');
    expect(sorted[2].type).toBe('prompt');
  });

  it('sorts patches by order', () => {
    const files: SourceFile[] = [
      { filename: '003_c.patch', content: '', type: 'patch', target: 'c', patchOrder: 3 },
      { filename: '001_a.patch', content: '', type: 'patch', target: 'a', patchOrder: 1 },
      { filename: '002_b.patch', content: '', type: 'patch', target: 'b', patchOrder: 2 },
    ];
    const sorted = sortFiles(files);
    expect(sorted[0].patchOrder).toBe(1);
    expect(sorted[1].patchOrder).toBe(2);
    expect(sorted[2].patchOrder).toBe(3);
  });
});

describe('unifiedDiff', () => {
  it('produces diff -u style hunks', () => {
    const diff = unifiedDiff('one\ntwo\n', 'one\nthree\n');
    expect(diff).toContain('@@ -1,2 +1,2 @@');
    expect(diff).toContain('-two');
    expect(diff).toContain('+three');
  });

  it('returns empty string for identical content', () => {
    expect(unifiedDiff('same\n', 'same\n')).toBe('');
  });
});

describe('cleanDiff content preservation', () => {
  it('keeps removed content lines that start with ---', () => {
    const diff = '--- old\n+++ new\n@@ -1,2 +1,1 @@\n---i;\n line\n';
    const cleaned = cleanDiff(diff);
    expect(cleaned).toContain('---i;');
    expect(cleaned).not.toContain('--- old');
    expect(cleaned).not.toContain('+++ new');
  });
});

describe('addMergeMarker', () => {
  it('stacks a block for a new distinct upstream change', () => {
    const first = addMergeMarker('local code', '@@ -1 +1 @@\n-v1\n+v2');
    expect(first.added).toBe(true);
    const second = addMergeMarker(first.content, '@@ -1 +1 @@\n-v2\n+v3');
    expect(second.added).toBe(true);
    expect((second.content.match(new RegExp(MERGE_START, 'g')) || []).length).toBe(2);
    expect(second.content).toContain('+v2');
    expect(second.content).toContain('+v3');
    expect(second.content).toContain('local code');
  });

  it('does not duplicate an identical block', () => {
    const first = addMergeMarker('local code', '@@ -1 +1 @@\n-v1\n+v2');
    const again = addMergeMarker(first.content, '@@ -1 +1 @@\n-v1\n+v2');
    expect(again.added).toBe(false);
    expect(again.content).toBe(first.content);
  });
});
