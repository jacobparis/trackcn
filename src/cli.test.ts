import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createHash } from 'crypto';

const CLI = join(import.meta.dirname, '..', 'dist', 'index.js');

function run(args: string | string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const argv = typeof args === 'string' ? args.split(/\s+/).filter(Boolean) : args;
  return new Promise((resolve) => {
    execFile('node', [CLI, ...argv], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 15000,
    }, (error, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', code: error ? (error as any).code ?? 1 : 0 });
    });
  });
}

// ============================================================================
// Mock GitHub API server
// ============================================================================

interface MockRoute {
  method: string;
  path: string | RegExp;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

function createMockServer(routes: MockRoute[]): { server: Server; url: string; start: () => Promise<string> } {
  const server = createServer((req, res) => {
    const route = routes.find((r) => {
      if (r.method !== req.method) return false;
      if (typeof r.path === 'string') return req.url === r.path;
      return r.path.test(req.url || '');
    });
    if (route) {
      route.handler(req, res);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ message: `Not found: ${req.method} ${req.url}` }));
    }
  });

  return {
    server,
    url: '',
    start: () => new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(`http://127.0.0.1:${addr.port}`);
        }
      });
    }),
  };
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function githubFile(path: string, content: string | Buffer) {
  return {
    name: path.split('/').pop(),
    path,
    type: 'file',
    download_url: null,
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
  };
}

// ============================================================================
// CLI: help and version
// ============================================================================

describe('CLI basics', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('--version prints version', async () => {
    const { stdout, code } = await run('--version', dir);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--help shows usage', async () => {
    const { stdout, code } = await run('--help', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('trackcn');
    expect(stdout).toContain('add');
    expect(stdout).toContain('pull');
    expect(stdout).toContain('status');
    expect(stdout).toContain('remove');
    expect(stdout).toContain('Start here (for AI agents):');
    expect(stdout).toContain('trackcn skills get trackcn');
  });

  it('no command shows help', async () => {
    const { stdout, code } = await run('', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('unknown command shows help and exits 1', async () => {
    const { stdout, code } = await run('unknown', dir);
    expect(code).toBe(1);
    expect(stdout).toContain('Usage:');
  });
});

// ============================================================================
// CLI: bundled skills
// ============================================================================

describe('CLI skills', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists bundled skills', async () => {
    const { stdout, code } = await run('skills', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('trackcn');
    expect(stdout).toContain('Core trackcn usage guide');
  });

  it('lists bundled skills as JSON', async () => {
    const { stdout, code } = await run('skills list --json', dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      skills: [
        {
          name: 'trackcn',
          description: 'Core trackcn usage guide. Read this before using trackcn to sync files or skills.',
        },
      ],
    });
  });

  it('loads the trackcn skill', async () => {
    const { stdout, code } = await run('skills get trackcn', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('name: trackcn');
    expect(stdout).toContain('# trackcn');
    expect(stdout).toContain('trackcn pull --json');
  });

  it('prints the bundled skill path', async () => {
    const { stdout, code } = await run('skills path trackcn', dir);
    expect(code).toBe(0);
    expect(existsSync(join(stdout.trim(), 'SKILL.md'))).toBe(true);
  });

  it('errors for an unknown skill', async () => {
    const { stderr, code } = await run('skills get unknown', dir);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown skill: unknown');
  });
});

// ============================================================================
// CLI: add with raw URL
// ============================================================================

describe('CLI add: raw URL', () => {
  let dir: string;
  let mockUrl: string;
  let mockServer: Server;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/file.txt',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello world\n');
        },
      },
    ]);
    mockUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  it('adds a raw URL file', async () => {
    const { code } = await run(`add ${mockUrl}/file.txt`, dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('hello world\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].url).toBe(`${mockUrl}/file.txt`);
    expect(Object.keys(manifest.sources[0].files)).toContain('file.txt');
  });

  it('add --json outputs structured JSON', async () => {
    const { stdout, code } = await run(`add ${mockUrl}/file.txt --json`, dir);
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.sources[0].source).toBe(`${mockUrl}/file.txt`);
    expect(output.sources[0].added).toContain('file.txt');
  });

  it('add --dry-run does not write the target file', async () => {
    const { code } = await run(`add ${mockUrl}/file.txt --dry-run`, dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'file.txt'))).toBe(false);
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('add skips existing untracked file', async () => {
    writeFileSync(join(dir, 'file.txt'), 'existing content');
    const { stdout, code } = await run(`add ${mockUrl}/file.txt`, dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('existing content');
    expect(stdout).toContain('Skipped');
  });

  it('add --force overwrites existing untracked file', async () => {
    writeFileSync(join(dir, 'file.txt'), 'existing content');
    const { code } = await run(`add ${mockUrl}/file.txt --force`, dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('hello world\n');
  });

  it('add with directory target writes file there', async () => {
    mkdirSync(join(dir, 'subdir'), { recursive: true });
    const { code } = await run(`add ${mockUrl}/file.txt ./subdir`, dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'subdir', 'file.txt'), 'utf-8')).toBe('hello world\n');
  });

  it('adds the same source independently to two destinations', async () => {
    await run(`add ${mockUrl}/file.txt ./one`, dir);
    await run(`add ${mockUrl}/file.txt ./two`, dir);

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.sources.map((source: { prefix: string }) => source.prefix)).toEqual(['one', 'two']);
  });

  it('add when content matches updates tracking without writing', async () => {
    // First add
    await run(`add ${mockUrl}/file.txt`, dir);
    const manifest1 = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));

    // Second add — content matches
    const { code } = await run(`add ${mockUrl}/file.txt`, dir);
    expect(code).toBe(0);
    const manifest2 = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest2.sources[0].files['file.txt']).toBe(manifest1.sources[0].files['file.txt']);
  });
});

// ============================================================================
// CLI: pull with raw URL
// ============================================================================

describe('CLI pull: raw URL', () => {
  let dir: string;
  let mockServer: Server;
  let url: string;
  let fileContent = 'v1 content\n';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/file.txt',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fileContent);
        },
      },
    ]);
    url = await mock.start();
    mockServer = mock.server;

    // Initial add
    fileContent = 'v1 content\n';
    await run(`add ${url}/file.txt`, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
    fileContent = 'v1 content\n';
  });

  it('pull with no changes says up to date', async () => {
    const { stdout, code } = await run('pull', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('up to date');
  });

  it('pull updates file when upstream changes', async () => {
    fileContent = 'v2 content\n';
    const { code } = await run('pull', dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('v2 content\n');
  });

  it('pull preserves a non-root destination', async () => {
    const destination = mkdtempSync(join(tmpdir(), 'trackcn-destination-'));
    try {
      await run(`remove ${url}/file.txt --hard`, dir);
      await run(`add ${url}/file.txt ${destination}`, dir);
      fileContent = 'v2 content\n';

      const { code } = await run('pull', dir);
      expect(code).toBe(0);
      expect(readFileSync(join(destination, 'file.txt'), 'utf-8')).toBe('v2 content\n');
      expect(existsSync(join(dir, 'file.txt'))).toBe(false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('pull adds merge markers when file locally modified and upstream changed', async () => {
    writeFileSync(join(dir, 'file.txt'), 'local modification\n');
    fileContent = 'v2 content\n';
    const { stdout, code } = await run('pull', dir);
    expect(code).toBe(0);
    const content = readFileSync(join(dir, 'file.txt'), 'utf-8');
    expect(content).toContain('<<<<<<< trackcn');
    expect(content).toContain('>>>>>>> trackcn');
    expect(content).toContain('local modification');
    expect(stdout).toContain('Merge markers');
  });

  it('pull --force overwrites locally modified file', async () => {
    writeFileSync(join(dir, 'file.txt'), 'local modification\n');
    fileContent = 'v2 content\n';
    const { code } = await run('pull --force', dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('v2 content\n');
  });

  it('pull --dry-run does not modify files', async () => {
    fileContent = 'v2 content\n';
    const { code } = await run('pull --dry-run', dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'file.txt'), 'utf-8')).toBe('v1 content\n');
  });

  it('pull --json outputs structured JSON', async () => {
    fileContent = 'v2 content\n';
    const { stdout, code } = await run('pull --json', dir);
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.updated).toContain('file.txt');
  });

  it('merge markers do not pile up on second pull', async () => {
    writeFileSync(join(dir, 'file.txt'), 'local modification\n');
    fileContent = 'v2 content\n';
    await run('pull', dir);
    // File now has markers. Pull again — content hasn't changed since we updated version.
    const { code } = await run('pull', dir);
    expect(code).toBe(0);
    const content = readFileSync(join(dir, 'file.txt'), 'utf-8');
    const markerCount = content.split('<<<<<<< trackcn').length - 1;
    expect(markerCount).toBe(1);
  });
});

// ============================================================================
// CLI: status
// ============================================================================

describe('CLI status', () => {
  let dir: string;
  let mockServer: Server;
  let fileAvailable = true;
  let fileContent = 'content\n';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/file.txt',
        handler: (_req, res) => {
          if (!fileAvailable) {
            res.writeHead(500);
            res.end('unavailable');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fileContent);
        },
      },
    ]);
    const url = await mock.start();
    mockServer = mock.server;
    await run(`add ${url}/file.txt`, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
    fileAvailable = true;
    fileContent = 'content\n';
  });

  it('status exits 0 when up to date', async () => {
    const { code } = await run('status', dir);
    expect(code).toBe(0);
  });

  it('status stays minimal when only local files are modified', async () => {
    writeFileSync(join(dir, 'file.txt'), 'modified\n');
    const { stdout, code } = await run('status', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('No upstream changes.');
    expect(stdout).not.toContain('modified locally');
  });

  it('status --json outputs structured JSON', async () => {
    const { stdout, code } = await run('status --json', dir);
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.sources).toHaveLength(1);
    expect(output.stale).toBe(false);
    expect(output.drifted).toBe(false);
  });

  it('status detects locally modified files', async () => {
    writeFileSync(join(dir, 'file.txt'), 'modified\n');
    const { stdout } = await run('status --json', dir);
    const output = JSON.parse(stdout);
    expect(output.drifted).toBe(true);
    expect(output.sources[0].locallyModified).toContain('file.txt');
  });

  it('status shows upstream-modified files as M action items', async () => {
    fileContent = 'new content\n';
    const { stdout, code } = await run('status', dir, { FORCE_COLOR: '1' });
    expect(code).toBe(1);
    expect(stdout).toContain('\x1b[1;38;2;226;192;141mM\x1b[0m file.txt');
  });

  it('status shows upstream-present missing local files as A action items', async () => {
    rmSync(join(dir, 'file.txt'));
    fileContent = 'new content\n';
    const { stdout, code } = await run('status', dir, { FORCE_COLOR: '1' });
    expect(code).toBe(1);
    expect(stdout).toContain('\x1b[1;38;2;129;184;139mA\x1b[0m file.txt (missing locally)');
  });

  it('status shows upstream-and-local changes as C action items', async () => {
    writeFileSync(join(dir, 'file.txt'), 'local change\n');
    fileContent = 'new content\n';
    const { stdout, code } = await run('status', dir, { FORCE_COLOR: '1' });
    expect(code).toBe(1);
    expect(stdout).toContain('\x1b[1;38;2;199;78;57mC\x1b[0m file.txt (modified locally)');
  });

  it('status detects unresolved merge markers', async () => {
    writeFileSync(join(dir, 'file.txt'), '<<<<<<< trackcn\nsome diff\n>>>>>>> trackcn\ncode\n');
    const { stdout } = await run('status --json', dir);
    const output = JSON.parse(stdout);
    expect(output.sources[0].unresolvedMerges).toContain('file.txt');
  });

  it('status shows unresolved merge markers as human action items', async () => {
    writeFileSync(join(dir, 'file.txt'), '<<<<<<< trackcn\nsome diff\n>>>>>>> trackcn\ncode\n');
    const { stdout, code } = await run('status', dir, { FORCE_COLOR: '1' });
    expect(code).toBe(1);
    expect(stdout).toContain('\x1b[1;38;2;199;78;57mC\x1b[0m file.txt (unresolved merge)');
  });

  it('status exits 1 when an upstream fetch fails', async () => {
    fileAvailable = false;
    const { stdout, code } = await run('status --json', dir);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).failed).toBe(true);
  });

  it('status errors without trackcn.json', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const { code, stderr } = await run('status', emptyDir);
    expect(code).toBe(1);
    expect(stderr).toContain('No trackcn.json');
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ============================================================================
// CLI: remove
// ============================================================================

describe('CLI remove', () => {
  let dir: string;
  let mockServer: Server;
  let mockUrl: string;
  let fileContent = 'content\n';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/file.txt',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fileContent);
        },
      },
    ]);
    mockUrl = await mock.start();
    mockServer = mock.server;
    await run(`add ${mockUrl}/file.txt`, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
    fileContent = 'content\n';
  });

  it('remove untracks source but leaves files', async () => {
    const { code } = await run(`remove ${mockUrl}/file.txt`, dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'file.txt'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(0);
  });

  it('remove --hard deletes tracked files', async () => {
    const { code } = await run(`remove ${mockUrl}/file.txt --hard`, dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'file.txt'))).toBe(false);
  });

  it('remove with partial match works', async () => {
    // Use the mock URL which is a parseable URL — partial match by substring
    // The canonical URL is http://127.0.0.1:PORT/file.txt
    // We can match with the full URL (exact) since partial requires parseUrl to succeed first
    const { code } = await run(`remove ${mockUrl}/file.txt`, dir);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(0);
  });

  it('remove --json outputs structured JSON', async () => {
    const { stdout, code } = await run(`remove ${mockUrl}/file.txt --json`, dir);
    expect(code).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.url).toBe(`${mockUrl}/file.txt`);
  });

  it('remove non-existent source errors', async () => {
    const { code, stderr } = await run('remove https://example.com/nonexistent', dir);
    expect(code).toBe(1);
    expect(stderr).toContain('Source or tracked path not found');
  });

  it('remove on a tracked subpath adds it to the source ignore list', async () => {
    const { code } = await run('remove file.txt', dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'file.txt'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].ignore).toEqual(['file.txt']);
    expect(manifest.sources[0].files).not.toHaveProperty('file.txt');
  });

  it('remove --hard on a tracked subpath ignores and deletes it', async () => {
    const { code } = await run('remove file.txt --hard', dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'file.txt'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].ignore).toEqual(['file.txt']);
  });

  it('ignored subpaths do not become upstream status actions', async () => {
    await run('remove file.txt', dir);
    fileContent = 'new upstream content\n';
    const { stdout, code } = await run('status', dir);
    expect(code).toBe(0);
    expect(stdout).toContain('No upstream changes.');
  });
});

// ============================================================================
// CLI: add with post-pull hook
// ============================================================================

describe('CLI add: post-pull hook', () => {
  let dir: string;
  let mockServer: Server;
  let fileContent = 'v1\n';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/file.txt',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(fileContent);
        },
      },
    ]);
    const url = await mock.start();
    mockServer = mock.server;
    fileContent = 'v1\n';
    await run(['add', `${url}/file.txt`, '--post-pull', `touch ${dir}/hook-ran`], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
    fileContent = 'v1\n';
  });

  it('stores post-pull in manifest', async () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0]['post-pull']).toContain('touch');
  });

  it('runs hook on pull when files change', async () => {
    fileContent = 'v2\n';
    await run('pull', dir);
    expect(existsSync(join(dir, 'hook-ran'))).toBe(true);
  });

  it('does not run hook when no changes', async () => {
    await run('pull', dir);
    expect(existsSync(join(dir, 'hook-ran'))).toBe(false);
  });

  it('exits 1 when a hook fails', async () => {
    const manifestPath = join(dir, 'trackcn.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.sources[0]['post-pull'] = 'exit 7';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fileContent = 'v2\n';

    const { stdout, code } = await run('pull --json', dir);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).errors[0].error).toContain('post-pull hook failed');
  });
});

// ============================================================================
// CLI: GitHub shorthand and curated registry bundles
// ============================================================================

describe('CLI add: GitHub shorthand and curated bundles', () => {
  let dir: string;
  let mockServer: Server;
  let githubApiUrl: string;
  let sha = 'sha-v1';
  let registryItems: Array<Record<string, unknown>> = [];
  let registryIncludes: string[] = [];
  let registryAvailable = true;
  let downloadAuthorization = '';
  let commitAuthorization = '';
  let trunkCommitRequests = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    sha = 'sha-v1';
    registryIncludes = [];
    registryAvailable = true;
    downloadAuthorization = '';
    commitAuthorization = '';
    trunkCommitRequests = 0;
    registryItems = [
      {
        name: 'base-rules',
        type: 'registry:item',
        files: [
          {
            path: 'rules/base.md',
            type: 'registry:file',
            target: '~/.agents/rules/base.md',
            content: 'base v1\n',
          },
        ],
      },
      {
        name: 'project-conventions',
        type: 'registry:item',
        title: 'Project conventions',
        description: 'Shared repository rules',
        dependencies: ['zod'],
        registryDependencies: ['acme/toolkit/base-rules', 'acme/external/optional-rules'],
        files: [
          {
            path: 'rules/review.md',
            type: 'registry:file',
            target: '.agents/rules/review.md',
            content: 'review v1\n',
          },
        ],
      },
    ];

    const mock = createMockServer([
      {
        method: 'GET',
        path: '/repos/acme/toolkit',
        handler: (_req, res) => jsonResponse(res, { default_branch: 'trunk' }),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/contents/registry.json?ref=trunk',
        handler: (_req, res) => {
          if (!registryAvailable) return jsonResponse(res, { message: 'Not found' }, 404);
          jsonResponse(res, githubFile('registry.json', JSON.stringify({ include: registryIncludes, items: registryItems })));
        },
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/contents/registry.json?ref=v1.0.0',
        handler: (_req, res) => jsonResponse(res, githubFile('registry.json', JSON.stringify({ include: registryIncludes, items: registryItems }))),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/contents/rules/registry.json?ref=trunk',
        handler: (_req, res) => jsonResponse(res, githubFile('rules/registry.json', JSON.stringify({
          items: [
            {
              name: 'rules/agent',
              type: 'registry:item',
              files: [
                {
                  path: 'agent.md',
                  type: 'registry:file',
                  target: '~/AGENTS.md',
                },
              ],
            },
          ],
        }))),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/contents/rules/agent.md?ref=trunk',
        handler: (_req, res) => jsonResponse(res, githubFile('rules/agent.md', '# Agent rules\n')),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/toolkit\/contents\/\?ref=/,
        handler: (_req, res) => jsonResponse(res, [
          {
            name: 'README.md',
            path: 'README.md',
            type: 'file',
            download_url: `${githubApiUrl}/raw/README.md`,
          },
        ]),
      },
      {
        method: 'GET',
        path: '/raw/README.md',
        handler: (req, res) => {
          downloadAuthorization = req.headers.authorization || '';
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('# Toolkit\n');
        },
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/contents/rules?ref=trunk',
        handler: (_req, res) => jsonResponse(res, githubFile('rules', 'path fallback\n')),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/commits/trunk',
        handler: (req, res) => {
          trunkCommitRequests++;
          commitAuthorization = req.headers.authorization || '';
          jsonResponse(res, { sha });
        },
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/commits/v1.0.0',
        handler: (_req, res) => jsonResponse(res, { sha: 'sha-tag-v1' }),
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  function githubEnv() {
    return { TRACKCN_GITHUB_API_URL: githubApiUrl };
  }

  it('shows a neutral repository menu and curated items without writing a manifest', async () => {
    const { stdout, code } = await run('add acme/toolkit', dir, githubEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('Install the complete repository:');
    expect(stdout).toContain('trackcn add acme/toolkit .');
    expect(stdout).toContain('Curated bundles:');
    expect(stdout).toContain('project-conventions');
    expect(stdout).not.toContain('does not publish');
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('shows a neutral repository menu when no curated bundles are published', async () => {
    registryAvailable = false;
    const { stdout, code } = await run('add acme/toolkit', dir, githubEnv());
    expect(code).toBe(0);
    expect(stdout).toContain('Install the complete repository:');
    expect(stdout).not.toContain('Curated bundles:');
    expect(stdout).not.toContain('does not publish');
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('installs the complete repository into an explicit destination using its default branch', async () => {
    const { code } = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toBe('# Toolkit\n');
    expect(downloadAuthorization).toBe('token secret');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].url).toBe('https://github.com/acme/toolkit/tree/trunk');
  });

  it('prints compact GitHub source labels in status output', async () => {
    const add = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(add.code).toBe(0);

    const manifestPath = join(dir, 'trackcn.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.sources[0].files['OLD.md'] = 'old-hash';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    sha = 'sha-v2';

    const status = await run('status', dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(status.code).toBe(1);
    expect(status.stdout).toContain('acme/toolkit@sha-v1');
    expect(status.stdout).not.toContain('https://github.com/acme/toolkit/tree/trunk');

    const colorStatus = await run('status', dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
      FORCE_COLOR: '1',
    });
    expect(colorStatus.code).toBe(1);
    expect(colorStatus.stdout).toContain('acme/toolkit\x1b[2m@sha-v1\x1b[0m');
  });

  it('reuses repo/ref commit lookups across status sources', async () => {
    const add = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(add.code).toBe(0);

    const manifestPath = join(dir, 'trackcn.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.sources.push({
      ...manifest.sources[0],
      files: {},
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    trunkCommitRequests = 0;
    const status = await run('status', dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(status.code).toBe(0);
    expect(trunkCommitRequests).toBe(1);
  });

  it('status shows files removed upstream as D action items', async () => {
    const add = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
    });
    expect(add.code).toBe(0);

    writeFileSync(join(dir, 'OLD.md'), 'old\n');
    const manifestPath = join(dir, 'trackcn.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.sources[0].files['OLD.md'] = 'old-hash';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    sha = 'sha-v2';

    const status = await run('status', dir, {
      ...githubEnv(),
      GITHUB_TOKEN: 'secret',
      FORCE_COLOR: '1',
    });
    expect(status.code).toBe(1);
    expect(status.stdout).toContain('\x1b[1;38;2;199;78;57mD\x1b[0m OLD.md');
  });

  it('uses a stored trackcn GitHub token when available', async () => {
    const home = mkdtempSync(join(tmpdir(), 'trackcn-home-'));
    mkdirSync(join(home, '.trackcn'), { recursive: true });
    writeFileSync(join(home, '.trackcn', 'auth.json'), JSON.stringify({
      github: { token: 'stored-token', expiresAt: Date.now() + 3_600_000 },
    }));

    const { code } = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      HOME: home,
      TRACKCN_GITHUB_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
    });

    rmSync(home, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(commitAuthorization).toBe('token stored-token');
  });

  it('runs GitHub App device login and retries when anonymous requests are rejected', async () => {
    let commitRequests = 0;
    let tokenPolls = 0;
    let privateCommitAuthorization = '';
    mockServer.close();

    const mock = createMockServer([
      {
        method: 'POST',
        path: '/login/device/code',
        handler: (_req, res) => jsonResponse(res, {
          device_code: 'device-code',
          user_code: 'ABCD-1234',
          verification_uri: `${githubApiUrl}/login/device`,
          expires_in: 60,
          interval: 1,
        }),
      },
      {
        method: 'POST',
        path: '/login/oauth/access_token',
        handler: (_req, res) => {
          tokenPolls++;
          jsonResponse(res, { access_token: 'app-token', expires_in: 3600 });
        },
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit',
        handler: (_req, res) => jsonResponse(res, { default_branch: 'trunk' }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/toolkit\/contents\/\?ref=/,
        handler: (_req, res) => jsonResponse(res, [
          {
            name: 'README.md',
            path: 'README.md',
            type: 'file',
            download_url: `${githubApiUrl}/raw/README.md`,
          },
        ]),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/commits/trunk',
        handler: (req, res) => {
          commitRequests++;
          if (!req.headers.authorization) return jsonResponse(res, { message: 'API rate limit exceeded' }, 403);
          privateCommitAuthorization = req.headers.authorization;
          jsonResponse(res, { sha });
        },
      },
      {
        method: 'GET',
        path: '/raw/README.md',
        handler: (req, res) => {
          downloadAuthorization = req.headers.authorization || '';
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('# Toolkit\n');
        },
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;

    const home = mkdtempSync(join(tmpdir(), 'trackcn-home-'));

    const { code } = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      TRACKCN_GITHUB_WEB_URL: githubApiUrl,
      TRACKCN_GITHUB_CLIENT_ID: 'client-id',
      TRACKCN_GITHUB_AUTO_LOGIN: '1',
      TRACKCN_GITHUB_OPEN_BROWSER: '0',
      HOME: home,
      TRACKCN_GITHUB_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
    });

    rmSync(home, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(commitRequests).toBe(2);
    expect(tokenPolls).toBe(1);
    expect(privateCommitAuthorization).toBe('token app-token');
  });

  it('preemptively logs in when the anonymous quota is nearly exhausted', async () => {
    let tokenPolls = 0;
    let authedCommitRequests = 0;
    mockServer.close();

    const mock = createMockServer([
      {
        method: 'POST',
        path: '/login/device/code',
        handler: (_req, res) => jsonResponse(res, {
          device_code: 'device-code',
          user_code: 'ABCD-1234',
          verification_uri: `${githubApiUrl}/login/device`,
          expires_in: 60,
          interval: 1,
        }),
      },
      {
        method: 'POST',
        path: '/login/oauth/access_token',
        handler: (_req, res) => {
          tokenPolls++;
          jsonResponse(res, { access_token: 'app-token', expires_in: 3600 });
        },
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit',
        handler: (req, res) => {
          // Anonymous requests are nearly out of quota
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': req.headers.authorization ? '4999' : '3',
          });
          res.end(JSON.stringify({ default_branch: 'trunk' }));
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/toolkit\/contents\/\?ref=/,
        handler: (_req, res) => jsonResponse(res, [
          {
            name: 'README.md',
            path: 'README.md',
            type: 'file',
            download_url: `${githubApiUrl}/raw/README.md`,
          },
        ]),
      },
      {
        method: 'GET',
        path: '/repos/acme/toolkit/commits/trunk',
        handler: (req, res) => {
          if (req.headers.authorization) authedCommitRequests++;
          jsonResponse(res, { sha: 'sha-v1' });
        },
      },
      {
        method: 'GET',
        path: '/raw/README.md',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('# Toolkit\n');
        },
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;

    const home = mkdtempSync(join(tmpdir(), 'trackcn-home-'));

    const { code } = await run(['add', 'acme/toolkit', '.'], dir, {
      ...githubEnv(),
      TRACKCN_GITHUB_WEB_URL: githubApiUrl,
      TRACKCN_GITHUB_CLIENT_ID: 'client-id',
      TRACKCN_GITHUB_AUTO_LOGIN: '1',
      TRACKCN_GITHUB_OPEN_BROWSER: '0',
      HOME: home,
      TRACKCN_GITHUB_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
    });

    rmSync(home, { recursive: true, force: true });
    expect(code).toBe(0);
    // The login happened before any request failed, and later calls used it
    expect(tokenPolls).toBe(1);
    expect(authedCommitRequests).toBeGreaterThan(0);
  });

  it('never fails on alias targets: components.json resolves them, otherwise the alias becomes a directory', async () => {
    registryItems = [
      {
        name: 'button',
        type: 'registry:item',
        files: [
          {
            path: 'ui/button.tsx',
            type: 'registry:file',
            target: '@ui/button.tsx',
            content: 'export const Button = null\n',
          },
        ],
      },
    ];

    // No components.json — mechanical fallback: @ui/button.tsx -> ui/button.tsx
    const bare = await run('add acme/toolkit/button', dir, { ...githubEnv(), GITHUB_TOKEN: 'secret' });
    expect(bare.code).toBe(0);
    expect(readFileSync(join(dir, 'ui/button.tsx'), 'utf-8')).toBe('export const Button = null\n');

    // With components.json — the alias wins
    const dir2 = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    writeFileSync(join(dir2, 'components.json'), JSON.stringify({ aliases: { ui: '@/src/components/ui' } }));
    const aliased = await run('add acme/toolkit/button', dir2, { ...githubEnv(), GITHUB_TOKEN: 'secret' });
    expect(aliased.code).toBe(0);
    expect(readFileSync(join(dir2, 'src/components/ui/button.tsx'), 'utf-8')).toBe('export const Button = null\n');
    rmSync(dir2, { recursive: true, force: true });

    // Malformed components.json — still installs via the fallback
    const dir3 = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    writeFileSync(join(dir3, 'components.json'), '{not json');
    const broken = await run('add acme/toolkit/button', dir3, { ...githubEnv(), GITHUB_TOKEN: 'secret' });
    expect(broken.code).toBe(0);
    expect(readFileSync(join(dir3, 'ui/button.tsx'), 'utf-8')).toBe('export const Button = null\n');
    rmSync(dir3, { recursive: true, force: true });
  });

  it('installs a curated bundle and records its requirements', async () => {
    const { code } = await run('add acme/toolkit/project-conventions', dir, githubEnv());
    expect(code).toBe(0);
    expect(readFileSync(join(dir, '.agents/rules/base.md'), 'utf-8')).toBe('base v1\n');
    expect(readFileSync(join(dir, '.agents/rules/review.md'), 'utf-8')).toBe('review v1\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0]).toMatchObject({
      url: 'acme/toolkit/project-conventions',
      type: 'github-registry-item',
      owner: 'acme',
      repo: 'toolkit',
      item: 'project-conventions',
      ref: 'trunk',
      version: 'sha-v1',
      requirements: {
        dependencies: ['zod'],
        registryDependencies: ['acme/external/optional-rules'],
      },
    });
  });

  it('installs a nested included item with project-root targets and relative file paths', async () => {
    registryItems = [];
    registryIncludes = ['rules/registry.json'];
    const { code } = await run('add acme/toolkit/rules/agent', dir, githubEnv());
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# Agent rules\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0]).toMatchObject({
      url: 'acme/toolkit/rules/agent',
      item: 'rules/agent',
      ref: 'trunk',
    });
  });

  it('installs a curated bundle from an explicit ref', async () => {
    const { code } = await run('add acme/toolkit/project-conventions#v1.0.0', dir, githubEnv());
    expect(code).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0]).toMatchObject({
      url: 'acme/toolkit/project-conventions#v1.0.0',
      ref: 'v1.0.0',
      version: 'sha-tag-v1',
    });
  });

  it('rejects curated bundle targets that escape the project', async () => {
    registryItems = [
      {
        name: 'unsafe',
        type: 'registry:item',
        files: [
          {
            path: 'outside.md',
            type: 'registry:file',
            target: '~/../outside.md',
            content: 'outside\n',
          },
        ],
      },
    ];

    const { stderr, code } = await run('add acme/toolkit/unsafe', dir, githubEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('Registry target must stay within the project');
  });

  it('refreshes curated bundles on pull and supports removing them', async () => {
    await run('add acme/toolkit/project-conventions', dir, githubEnv());
    sha = 'sha-v2';
    registryItems = [
      {
        name: 'project-conventions',
        type: 'registry:item',
        files: [
          {
            path: 'rules/conventions.md',
            type: 'registry:file',
            target: '.agents/rules/conventions.md',
            content: 'conventions v2\n',
          },
        ],
      },
    ];

    const status = await run('status --json', dir, githubEnv());
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout).stale).toBe(true);

    const pull = await run('pull --json', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(existsSync(join(dir, '.agents/rules/base.md'))).toBe(false);
    expect(existsSync(join(dir, '.agents/rules/review.md'))).toBe(false);
    expect(readFileSync(join(dir, '.agents/rules/conventions.md'), 'utf-8')).toBe('conventions v2\n');

    const removed = await run('remove acme/toolkit/project-conventions --hard', dir, githubEnv());
    expect(removed.code).toBe(0);
    expect(existsSync(join(dir, '.agents/rules/conventions.md'))).toBe(false);
  });

  it('falls back to a repository path when a curated item is not present', async () => {
    const { code } = await run('add acme/toolkit/rules', dir, githubEnv());
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'rules'), 'utf-8')).toBe('path fallback\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].url).toBe('https://github.com/acme/toolkit/tree/trunk/rules');
    expect(manifest.sources[0].type).toBeUndefined();
  });
});

// ============================================================================
// Pull: repo sources (single files, file targets, compare truncation)
// ============================================================================

describe('pull: repo sources', () => {
  let dir: string;
  let mockServer: Server;
  let githubApiUrl = '';

  // Mutable upstream state — tests change these between add and pull
  let fileContent = '';
  let headSha = '';
  let dirFiles: Record<string, string> = {};
  let compareFiles: Array<Record<string, unknown>> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    fileContent = 'hello v1\n';
    headSha = 'sha-v1';
    dirFiles = { 'src/a.md': 'aaa v1\n', 'src/b.md': 'bbb v1\n' };
    compareFiles = null;

    const mock = createMockServer([
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets$/,
        handler: (_req, res) => jsonResponse(res, { default_branch: 'main' }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/commits\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/,
        handler: (_req, res) => jsonResponse(res, { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/docs\/AGENTS\.md\?ref=(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|sha-v1|sha-v2)$/,
        handler: (req, res) => {
          const ref = (req.url || '').split('ref=')[1];
          const content = ref === 'sha-v2' ? fileContent : 'hello v1\n';
          jsonResponse(res, githubFile('docs/AGENTS.md', content));
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/commits\/main$/,
        handler: (_req, res) => jsonResponse(res, { sha: headSha }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/docs\/AGENTS\.md\?ref=main$/,
        handler: (_req, res) => jsonResponse(res, githubFile('docs/AGENTS.md', fileContent)),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/src\?ref=/,
        handler: (_req, res) => jsonResponse(res, Object.keys(dirFiles).map((p) => ({
          name: p.split('/').pop(),
          path: p,
          type: 'file',
          download_url: `${githubApiUrl}/raw/${p}`,
        }))),
      },
      {
        method: 'GET',
        path: /^\/raw\/src\//,
        handler: (req, res) => {
          const p = (req.url || '').replace('/raw/', '');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(dirFiles[p] ?? '');
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/compare\//,
        handler: (_req, res) => jsonResponse(res, { files: compareFiles ?? [] }),
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  function githubEnv() {
    return { TRACKCN_GITHUB_API_URL: githubApiUrl };
  }

  it('pulls upstream changes for a single-file source (merge markers when locally modified)', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8')).toBe('hello v1\n');

    // Local edit + upstream change
    writeFileSync(join(dir, 'notes/AGENTS.md'), 'hello local\n');
    fileContent = 'hello v2\n';
    headSha = 'sha-v2';

    const status = await run('status', dir, githubEnv());
    expect(status.code).toBe(1);
    expect(status.stdout).toContain('notes/AGENTS.md');

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    const onDisk = readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8');
    expect(onDisk).toContain('<<<<<<< trackcn');
    expect(onDisk).toContain('hello local');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v2');
  });

  it('pulls a clean upstream change for a single-file source without markers', async () => {
    await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());

    fileContent = 'hello v2\n';
    headSha = 'sha-v2';

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8')).toBe('hello v2\n');
  });

  it('treats a target with an extension as a file path (rename) and keeps it across pulls', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./renamed.md', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(readFileSync(join(dir, 'renamed.md'), 'utf-8')).toBe('hello v1\n');
    expect(existsSync(join(dir, 'renamed.md', 'AGENTS.md'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(Object.keys(manifest.sources[0].files)).toEqual(['renamed.md']);

    fileContent = 'hello v2\n';
    headSha = 'sha-v2';

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'renamed.md'), 'utf-8')).toBe('hello v2\n');
  });

  it('supports nested file targets', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./deep/dir/renamed.md', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(readFileSync(join(dir, 'deep/dir/renamed.md'), 'utf-8')).toBe('hello v1\n');
  });

  it('rejects a file-looking target for a directory source with a trailing-slash hint', async () => {
    const { code, stderr } = await run('add https://github.com/acme/widgets/tree/main/src ./v2.0', dir, githubEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('trailing slash');
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('treats a trailing-slash target with dots as a directory', async () => {
    const { code } = await run('add https://github.com/acme/widgets/tree/main/src ./v2.0/', dir, githubEnv());
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'v2.0/src/a.md'), 'utf-8')).toBe('aaa v1\n');
  });

  it('falls back to a full refetch when the compare is truncated at 300 files', async () => {
    const add = await run('add https://github.com/acme/widgets/tree/main/src ./vendor', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(readFileSync(join(dir, 'vendor/a.md'), 'utf-8')).toBe('aaa v1\n');

    // Upstream changes a.md, but the compare response is truncated noise that
    // does not include it — trackcn must not trust it.
    dirFiles = { 'src/a.md': 'aaa v2\n', 'src/b.md': 'bbb v1\n' };
    headSha = 'sha-v2';
    compareFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `unrelated/file-${i}.txt`,
      status: 'modified',
    }));

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'vendor/a.md'), 'utf-8')).toBe('aaa v2\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v2');
  });

  it('refuses to add a changeset that the GitHub API reports as truncated', async () => {
    compareFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `file-${i}.txt`,
      status: 'added',
    }));
    const { code, stderr } = await run('add https://github.com/acme/widgets/compare/sha-v1...main', dir, githubEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('truncates at 300');
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('treats a commit SHA in the source URL as a baseline and pulls default-branch updates', async () => {
    const add = await run('add https://github.com/acme/widgets/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/AGENTS.md ./notes', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8')).toBe('hello v1\n');

    const before = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(before.sources[0].version).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Upstream default branch moves ahead of the baseline SHA
    fileContent = 'hello v2\n';
    headSha = 'sha-v2';

    const status = await run('status --json', dir, githubEnv());
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout).stale).toBe(true);

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8')).toBe('hello v2\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v2');
    // The URL keeps the baseline SHA for provenance
    expect(manifest.sources[0].url).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});

describe('add: directory containing a single file', () => {
  let dir: string;
  let mockServer: Server;
  let githubApiUrl = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/commits\/main$/,
        handler: (_req, res) => jsonResponse(res, { sha: 'sha-v1' }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/skills\/solo\?ref=/,
        handler: (_req, res) => jsonResponse(res, [{
          name: 'SKILL.md',
          path: 'skills/solo/SKILL.md',
          type: 'file',
          download_url: `${githubApiUrl}/raw/skills/solo/SKILL.md`,
        }]),
      },
      {
        method: 'GET',
        path: /^\/raw\/skills\/solo\/SKILL\.md$/,
        handler: (_req, res) => { res.writeHead(200); res.end('solo skill\n'); },
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  it('derives a subdirectory for a one-file directory source with a trailing-slash target', async () => {
    const { code } = await run('add https://github.com/acme/widgets/tree/main/skills/solo ./up/', dir, { TRACKCN_GITHUB_API_URL: githubApiUrl });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'up/solo/SKILL.md'), 'utf-8')).toBe('solo skill\n');
  });

  it('rejects a file-path target for a one-file directory source', async () => {
    const { code, stderr } = await run('add https://github.com/acme/widgets/tree/main/skills/solo ./solo.md', dir, { TRACKCN_GITHUB_API_URL: githubApiUrl });
    expect(code).toBe(1);
    expect(stderr).toContain('trailing slash');
  });
});

// ============================================================================
// Binary files (PNG et al.) — bytes must survive add/pull/status verbatim
// ============================================================================

describe('binary files', () => {
  // Starts with the PNG magic bytes and contains sequences (0x89, 0xff 0xfe,
  // NULs) that do not survive a utf-8 round trip.
  const PNG_V1 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0xff, 0xfe, 0x00, 0x01,
  ]);
  const PNG_V2 = Buffer.concat([PNG_V1, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  const PNG_LOCAL = Buffer.concat([PNG_V1, Buffer.from([0x99])]);
  const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

  let dir: string;
  let mockServer: Server;
  let githubApiUrl = '';
  let pngBytes = PNG_V1;
  let headSha = 'sha-v1';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    pngBytes = PNG_V1;
    headSha = 'sha-v1';

    const mock = createMockServer([
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/commits\/main$/,
        handler: (_req, res) => jsonResponse(res, { sha: headSha }),
      },
      {
        // Single-file contents API — GitHub inlines base64 for blobs
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/assets\/logo\.png\?ref=/,
        handler: (_req, res) => jsonResponse(res, githubFile('assets/logo.png', pngBytes)),
      },
      {
        // Directory listing — files resolve through download_url raw bytes
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/assets\?ref=/,
        handler: (_req, res) => jsonResponse(res, [
          { name: 'logo.png', path: 'assets/logo.png', type: 'file', download_url: `${githubApiUrl}/raw/assets/logo.png` },
          { name: 'README.md', path: 'assets/README.md', type: 'file', download_url: `${githubApiUrl}/raw/assets/README.md` },
        ]),
      },
      {
        method: 'GET',
        path: /^\/raw\/assets\/logo\.png$/,
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(pngBytes);
        },
      },
      {
        method: 'GET',
        path: /^\/raw\/assets\/README\.md$/,
        handler: (_req, res) => { res.writeHead(200); res.end('readme\n'); },
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  function githubEnv() {
    return { TRACKCN_GITHUB_API_URL: githubApiUrl };
  }

  it('add writes a base64-inlined PNG byte-identical and hashes the raw bytes', async () => {
    const { code } = await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());
    expect(code).toBe(0);

    const onDisk = readFileSync(join(dir, 'img/logo.png'));
    expect(onDisk.equals(PNG_V1)).toBe(true);
    expect(onDisk.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].files['img/logo.png']).toBe(sha256(PNG_V1));
  });

  it('add writes a download_url-served PNG in a directory byte-identical', async () => {
    const { code } = await run('add https://github.com/acme/widgets/tree/main/assets ./vendor', dir, githubEnv());
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'vendor/logo.png')).equals(PNG_V1)).toBe(true);
    expect(readFileSync(join(dir, 'vendor/README.md'), 'utf-8')).toBe('readme\n');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].files['vendor/logo.png']).toBe(sha256(PNG_V1));
  });

  it('status and pull see an unchanged binary file as up to date (stable hashes)', async () => {
    await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());

    const status = await run('status', dir, githubEnv());
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('No upstream changes');

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(pull.stdout).toContain('up to date');
    expect(readFileSync(join(dir, 'img/logo.png')).equals(PNG_V1)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].files['img/logo.png']).toBe(sha256(PNG_V1));
  });

  it('pull updates an unmodified binary file byte-identical when upstream changes', async () => {
    await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());

    pngBytes = PNG_V2;
    headSha = 'sha-v2';

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'img/logo.png')).equals(PNG_V2)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v2');
    expect(manifest.sources[0].files['img/logo.png']).toBe(sha256(PNG_V2));
  });

  it('pull skips a binary conflict with a warning instead of merge markers', async () => {
    await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());

    writeFileSync(join(dir, 'img/logo.png'), PNG_LOCAL);
    pngBytes = PNG_V2;
    headSha = 'sha-v2';

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(pull.stdout).toContain('binary file conflict');
    expect(pull.stdout).not.toContain('Merge markers');

    const onDisk = readFileSync(join(dir, 'img/logo.png'));
    expect(onDisk.equals(PNG_LOCAL)).toBe(true);
    expect(onDisk.includes('<<<<<<< trackcn')).toBe(false);
  });

  it('pull --force overwrites a locally modified binary file byte-identical', async () => {
    await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());

    writeFileSync(join(dir, 'img/logo.png'), PNG_LOCAL);
    pngBytes = PNG_V2;
    headSha = 'sha-v2';

    const pull = await run('pull --force', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'img/logo.png')).equals(PNG_V2)).toBe(true);
  });

  it('add skips a binary conflict on re-add of a tracked, locally modified file', async () => {
    await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());

    writeFileSync(join(dir, 'img/logo.png'), PNG_LOCAL);
    pngBytes = PNG_V2;
    headSha = 'sha-v2';

    const add = await run('add https://github.com/acme/widgets/blob/main/assets/logo.png ./img', dir, githubEnv());
    expect(add.code).toBe(0);
    expect(add.stdout).toContain('binary file conflict');
    expect(readFileSync(join(dir, 'img/logo.png')).equals(PNG_LOCAL)).toBe(true);
  });
});

describe('binary files: raw URL sources', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01]);
  let dir: string;
  let mockServer: Server;
  let url = '';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    const mock = createMockServer([
      {
        method: 'GET',
        path: '/logo.png',
        handler: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(PNG);
        },
      },
    ]);
    url = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  it('adds a raw binary URL byte-identical and status stays stable', async () => {
    const { code } = await run(`add ${url}/logo.png`, dir);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'logo.png')).equals(PNG)).toBe(true);

    // Raw sources use the content hash as the version — a text-decoded fetch
    // would mangle the bytes and report a permanently stale source.
    const status = await run('status', dir);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('No upstream changes');

    const pull = await run('pull', dir);
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'logo.png')).equals(PNG)).toBe(true);
  });
});

// ============================================================================
// Launch hardening: pull safety, merge semantics, path traversal, auth errors
// ============================================================================

describe('pull safety and merge semantics', () => {
  let dir: string;
  let mockServer: Server;
  let githubApiUrl = '';

  // Mutable upstream state
  let headSha = '';
  let contentByRef: Record<string, string> = {};
  let dirFiles: Record<string, string> = {};
  let compareFiles: Array<Record<string, unknown>> | null = null;
  let failContentsWith403 = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'trackcn-test-'));
    headSha = 'sha-v1';
    contentByRef = { 'sha-v1': 'hello v1\n', main: 'hello v1\n' };
    dirFiles = { 'src/a.md': 'aaa v1\n', 'src/b.md': 'bbb v1\n' };
    compareFiles = null;
    failContentsWith403 = false;

    const mock = createMockServer([
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets$/,
        handler: (_req, res) => jsonResponse(res, { default_branch: 'main' }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/commits\/main$/,
        handler: (_req, res) => jsonResponse(res, { sha: headSha }),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/docs\/AGENTS\.md\?ref=/,
        handler: (req, res) => {
          if (failContentsWith403) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0' });
            res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
            return;
          }
          const ref = decodeURIComponent((req.url || '').split('ref=')[1]);
          jsonResponse(res, githubFile('docs/AGENTS.md', contentByRef[ref] ?? contentByRef.main));
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/src\?ref=/,
        handler: (_req, res) => jsonResponse(res, Object.keys(dirFiles).map((p) => ({
          name: p.split('/').pop(),
          path: p,
          type: 'file',
          download_url: `${githubApiUrl}/raw/${p}`,
        }))),
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/contents\/src\/[^?]+\?ref=/,
        handler: (req, res) => {
          const p = decodeURIComponent((req.url || '').replace(/^\/repos\/acme\/widgets\/contents\//, '').split('?')[0]);
          if (dirFiles[p] === undefined) {
            res.writeHead(404);
            res.end(JSON.stringify({ message: 'Not Found' }));
            return;
          }
          jsonResponse(res, githubFile(p, dirFiles[p]));
        },
      },
      {
        method: 'GET',
        path: /^\/raw\/src\//,
        handler: (req, res) => {
          const p = (req.url || '').replace('/raw/', '');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(dirFiles[p] ?? '');
        },
      },
      {
        method: 'GET',
        path: /^\/repos\/acme\/widgets\/compare\//,
        handler: (_req, res) => jsonResponse(res, { files: compareFiles ?? [] }),
      },
      {
        method: 'GET',
        path: /^\/gists\/deadbeefdeadbeefdead$/,
        handler: (_req, res) => jsonResponse(res, {
          id: 'deadbeefdeadbeefdead',
          description: 'evil gist',
          files: {
            'C:_Users_Public_evil.bat': { filename: 'C:_Users_Public_evil.bat', content: 'echo pwned\n' },
          },
          history: [{ version: 'gist-v1' }],
        }),
      },
    ]);
    githubApiUrl = await mock.start();
    mockServer = mock.server;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockServer.close();
  });

  function githubEnv() {
    return { TRACKCN_GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', TRACKCN_GITHUB_TOKEN: '', GH_TOKEN: '', HOME: dir };
  }

  it('does not delete tracked files when the refetch fails transiently (rate limit)', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());
    expect(add.code).toBe(0);

    // Upstream moves, but the contents fetch starts failing with 403
    headSha = 'sha-v2';
    failContentsWith403 = true;

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(1);
    // The tracked file must survive, and the version must not advance
    expect(readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8')).toBe('hello v1\n');
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v1');
    expect(manifest.sources[0].files['notes/AGENTS.md']).toBeDefined();
  });

  it('merge markers carry the upstream diff, not the local edits as removals', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());
    expect(add.code).toBe(0);

    writeFileSync(join(dir, 'notes/AGENTS.md'), 'hello local\n');
    headSha = 'sha-v2';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', main: 'hello v2\n' };

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    const onDisk = readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8');
    expect(onDisk).toContain('<<<<<<< trackcn');
    // Upstream diff: v1 -> v2
    expect(onDisk).toContain('-hello v1');
    expect(onDisk).toContain('+hello v2');
    // The local edit is preserved below the block, never shown as a removal
    expect(onDisk).not.toContain('-hello local');
    expect(onDisk).toContain('hello local');
  });

  it('a second upstream change stacks a new marker block instead of being lost', async () => {
    await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());

    writeFileSync(join(dir, 'notes/AGENTS.md'), 'hello local\n');
    headSha = 'sha-v2';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', main: 'hello v2\n' };

    const first = await run('pull', dir, githubEnv());
    expect(first.code).toBe(0);
    expect((readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8').match(/<<<<<<< trackcn/g) || []).length).toBe(1);

    // Upstream moves again before the first marker is resolved
    headSha = 'sha-v3';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', 'sha-v3': 'hello v3\n', main: 'hello v3\n' };

    const second = await run('pull', dir, githubEnv());
    expect(second.code).toBe(0);
    const onDisk = readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8');
    expect((onDisk.match(/<<<<<<< trackcn/g) || []).length).toBe(2);
    // The second block carries the v2 -> v3 delta
    expect(onDisk).toContain('+hello v3');
    // Local content still intact
    expect(onDisk).toContain('hello local');

    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v3');
  });

  it('repeated pulls do not duplicate an identical marker block', async () => {
    await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());

    writeFileSync(join(dir, 'notes/AGENTS.md'), 'hello local\n');
    headSha = 'sha-v2';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', main: 'hello v2\n' };

    await run('pull', dir, githubEnv());
    await run('pull', dir, githubEnv());
    const onDisk = readFileSync(join(dir, 'notes/AGENTS.md'), 'utf-8');
    expect((onDisk.match(/<<<<<<< trackcn/g) || []).length).toBe(1);
  });

  it('does not clobber an existing untracked local file when upstream adds one', async () => {
    const add = await run('add https://github.com/acme/widgets/tree/main/src ./vendor', dir, githubEnv());
    expect(add.code).toBe(0);

    // A local, untracked file exists where upstream now adds one
    writeFileSync(join(dir, 'vendor/c.md'), 'my precious local file\n');
    headSha = 'sha-v2';
    dirFiles = { 'src/a.md': 'aaa v1\n', 'src/b.md': 'bbb v1\n', 'src/c.md': 'ccc v1\n' };
    compareFiles = [{ filename: 'src/c.md', status: 'added' }];

    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(readFileSync(join(dir, 'vendor/c.md'), 'utf-8')).toBe('my precious local file\n');
    expect(pull.stdout).toContain('added upstream, file exists locally');

    // The skip defers the version so the change stays applicable later
    const manifest = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(manifest.sources[0].version).toBe('sha-v1');

    const forced = await run('pull --force', dir, githubEnv());
    expect(forced.code).toBe(0);
    expect(readFileSync(join(dir, 'vendor/c.md'), 'utf-8')).toBe('ccc v1\n');
    const after = JSON.parse(readFileSync(join(dir, 'trackcn.json'), 'utf-8'));
    expect(after.sources[0].version).toBe('sha-v2');
  });

  it('rejects gist filenames that decode to drive-letter paths', async () => {
    const { code, stderr } = await run('add https://gist.github.com/user/deadbeefdeadbeefdead', dir, githubEnv());
    expect(code).not.toBe(0);
    expect(stderr).toContain('must stay within');
    expect(existsSync(join(dir, 'C:'))).toBe(false);
    expect(existsSync(join(dir, 'trackcn.json'))).toBe(false);
  });

  it('rate-limit errors point at GITHUB_TOKEN and never hang on auto-login when headless', async () => {
    const add = await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());
    expect(add.code).toBe(0);

    headSha = 'sha-v2';
    failContentsWith403 = true;

    // Not a TTY here — the browser device-code flow must not auto-start
    const pull = await run('pull', dir, githubEnv());
    expect(pull.code).toBe(1);
    expect(pull.stdout + pull.stderr).toContain('rate limit');
    expect(pull.stdout + pull.stderr).toContain('GITHUB_TOKEN');
    expect(pull.stdout + pull.stderr).not.toContain('login/device');
  });

  it('one failing source does not abort the rest of the pull', async () => {
    // Two sources: the failing single file, and a healthy directory
    await run('add https://github.com/acme/widgets/blob/main/docs/AGENTS.md ./notes', dir, githubEnv());
    await run('add https://github.com/acme/widgets/tree/main/src ./vendor', dir, githubEnv());

    headSha = 'sha-v2';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', main: 'hello v2\n' };
    failContentsWith403 = true; // only affects docs/AGENTS.md
    dirFiles = { 'src/a.md': 'aaa v2\n', 'src/b.md': 'bbb v1\n' };
    compareFiles = [{ filename: 'src/a.md', status: 'modified', patch: '@@ -1 +1 @@\n-aaa v1\n+aaa v2' }];

    const pull = await run('pull --json', dir, githubEnv());
    expect(pull.code).toBe(1); // errors reported
    const out = JSON.parse(pull.stdout);
    expect(out.errors.length).toBe(1);
    // The healthy source still updated
    expect(readFileSync(join(dir, 'vendor/a.md'), 'utf-8')).toBe('aaa v2\n');
  });

  it('announces post-pull hooks on stderr in --json mode', async () => {
    const add = await run(['add', 'https://github.com/acme/widgets/blob/main/docs/AGENTS.md', './notes', '--post-pull', 'echo hook-ok'], dir, githubEnv());
    expect(add.code).toBe(0);

    headSha = 'sha-v2';
    contentByRef = { 'sha-v1': 'hello v1\n', 'sha-v2': 'hello v2\n', main: 'hello v2\n' };

    const pull = await run('pull --json', dir, githubEnv());
    expect(pull.code).toBe(0);
    expect(pull.stderr).toContain('Running post-pull hook: echo hook-ok');
    expect(JSON.parse(pull.stdout).hooksRun).toEqual(['echo hook-ok']);
  });
});
