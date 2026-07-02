#!/usr/bin/env node

import arg from 'arg';
import { readFile, mkdir, writeFile, unlink, chmod } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename, extname, isAbsolute, posix } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  type FileType, type FileContent, type SourceFile, type ParsedSource, type ParsedRepo,
  categorizeFile, getPatchOrder, contentHash, decodeFetchedContent, asText, decodeGistFilename, sortFiles,
  MERGE_START, MERGE_END, hasMergeMarker, cleanDiff, prependMergeMarker, addMergeMarker, unifiedDiff,
  parseUrl, canonicalUrl, isLocalPath, lastPathSegment,
} from './lib.js';

// ============================================================================
// GitHub API Helpers
// ============================================================================

const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'trackcn-cli',
};

const GITHUB_API_URL = process.env.TRACKCN_GITHUB_API_URL || 'https://api.github.com';
const GITHUB_WEB_URL = process.env.TRACKCN_GITHUB_WEB_URL || 'https://github.com';
const DEFAULT_GITHUB_CLIENT_ID = 'Iv23lipAevefibNIkhzv';
const GITHUB_CLIENT_ID = process.env.TRACKCN_GITHUB_CLIENT_ID || DEFAULT_GITHUB_CLIENT_ID;
const AUTH_DIR = join(homedir(), '.trackcn');
const AUTH_PATH = join(AUTH_DIR, 'auth.json');

function githubApiUrl(path: string): string {
  return `${GITHUB_API_URL}${path}`;
}

interface GitHubAuth {
  token: string;
  source: string;
}

let cachedGitHubAuth: GitHubAuth | null | undefined;

function readStoredGitHubAuth(): GitHubAuth | null {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) as {
      github?: { token?: string; expiresAt?: number };
    };
    const token = auth.github?.token;
    const expiresAt = auth.github?.expiresAt;
    if (!token) return null;
    if (expiresAt && Date.now() > expiresAt - 60_000) return null;
    return { token, source: AUTH_PATH };
  } catch {
    return null;
  }
}

function getGitHubAuth(): GitHubAuth | null {
  if (cachedGitHubAuth !== undefined) return cachedGitHubAuth;

  const envToken = process.env.TRACKCN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    cachedGitHubAuth = {
      token: envToken,
      source: process.env.TRACKCN_GITHUB_TOKEN ? 'TRACKCN_GITHUB_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'GH_TOKEN',
    };
    return cachedGitHubAuth;
  }

  cachedGitHubAuth = readStoredGitHubAuth();
  return cachedGitHubAuth;
}

function githubAuthHeaders(): Record<string, string> {
  const auth = getGitHubAuth();
  return auth ? { Authorization: `token ${auth.token}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeStoredGitHubAuth(token: string, expiresIn?: number): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify({
    github: {
      token,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    },
  }, null, 2) + '\n');
  await chmod(AUTH_PATH, 0o600);
  cachedGitHubAuth = { token, source: AUTH_PATH };
}

function openBrowser(url: string): void {
  if (process.env.TRACKCN_GITHUB_OPEN_BROWSER === '0') return;
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
  } catch {
    // Printing the URL is enough for headless or minimal environments.
  }
}

async function fetchGitHubDeviceJson(path: string, body: URLSearchParams): Promise<any> {
  const response = await fetch(`${GITHUB_WEB_URL}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'trackcn-cli',
    },
    body,
  });
  if (!response.ok) {
    // GitHub returns the useful part (e.g. device_flow_disabled) in the body.
    const body = await response.json().catch(() => null) as { error?: string; error_description?: string } | null;
    const detail = body?.error_description || body?.error;
    throw new Error(`GitHub auth error: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return response.json();
}

async function loginWithGitHubApp(reason?: string): Promise<GitHubAuth> {
  if (!GITHUB_CLIENT_ID) {
    throw new Error(
      `GitHub authentication is required${reason ? ` (${reason})` : ''}.\n` +
      'Set GITHUB_TOKEN (or TRACKCN_GITHUB_TOKEN) to a GitHub token.\n' +
      'Browser login (`trackcn auth login`) is only available when TRACKCN_GITHUB_CLIENT_ID is set to a GitHub App OAuth client id.'
    );
  }

  const device = await fetchGitHubDeviceJson('/login/device/code', new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope: 'repo',
  })) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (!device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error(`GitHub auth error: ${device.error_description || device.error || 'invalid device response'}`);
  }

  const verificationUrl = device.verification_uri_complete || device.verification_uri;
  console.error(`GitHub login required${reason ? `: ${reason}` : ''}`);
  console.error(`Open ${verificationUrl} and enter code ${device.user_code}`);
  openBrowser(verificationUrl);

  let intervalMs = Math.max(1, device.interval || 5) * 1000;
  const deadline = Date.now() + Math.max(60, device.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const token = await fetchGitHubDeviceJson('/login/oauth/access_token', new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
      interval?: number;
    };

    if (token.access_token) {
      await writeStoredGitHubAuth(token.access_token, token.expires_in);
      console.error('GitHub login complete.');
      return cachedGitHubAuth!;
    }
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') {
      intervalMs += Math.max(1, token.interval || 5) * 1000;
      continue;
    }
    throw new Error(`GitHub auth error: ${token.error_description || token.error || 'unknown error'}`);
  }

  throw new Error('GitHub auth timed out before the login was completed.');
}

// 404 is deliberately absent: it usually means a typo'd URL, and bouncing that
// user into a browser login is worse than the "may be private" hint in the
// error message. Login provably fixes 401/403/429.
function isAuthRecoverableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

// Preemptive login fires at most once per process — if the user abandons the
// browser flow, keep going anonymously until the hard limit handles it.
let preemptiveLoginAttempted = false;

async function maybePreemptiveLogin(response: Response, allowLogin: boolean): Promise<void> {
  if (!response.ok || !allowLogin || preemptiveLoginAttempted) return;
  if (!canAutoLogin() || getGitHubAuth()) return;
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  if (remainingHeader === null) return;
  const remaining = Number(remainingHeader);
  // Log in before the anonymous quota runs dry instead of failing mid-operation.
  if (!Number.isFinite(remaining) || remaining > 5) return;
  preemptiveLoginAttempted = true;
  try {
    await loginWithGitHubApp(`only ${remaining} anonymous GitHub requests left this hour`);
  } catch (error) {
    console.error(`Continuing without login: ${(error as Error).message}`);
  }
}

// Auto-starting the browser device-code flow only makes sense on an
// interactive terminal — in CI/headless runs it would print a code and poll
// for up to 15 minutes. There, fail fast with the GITHUB_TOKEN hint instead.
// TRACKCN_GITHUB_AUTO_LOGIN=1/0 overrides the TTY detection either way.
function canAutoLogin(): boolean {
  if (!GITHUB_CLIENT_ID) return false;
  const override = process.env.TRACKCN_GITHUB_AUTO_LOGIN;
  if (override === '1') return true;
  if (override === '0') return false;
  return Boolean(process.stderr.isTTY);
}

// The browser login flow only exists on builds configured with a GitHub App
// client id — without one, errors point at token env vars instead.
function githubAuthHint(): string {
  if (getGitHubAuth()) return '';
  const login = GITHUB_CLIENT_ID ? ', or run `trackcn auth login`' : '';
  return `\nSet GITHUB_TOKEN (or TRACKCN_GITHUB_TOKEN)${login} for authenticated GitHub access.`;
}

function githubErrorFromStatus(response: Response, url: string): Error {
  if (response.status === 404) {
    return new Error(`Not found: ${url}${getGitHubAuth() ? '' : `\nIf this repository is private, authentication is required.${githubAuthHint()}`}`);
  }
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      return new Error(`GitHub rate limit exceeded${getGitHubAuth() ? '' : ' (unauthenticated requests are limited to 60/hour)'}.${githubAuthHint() || ' Try again later.'}`);
    }
    return new Error(`GitHub request forbidden (${response.status}).${githubAuthHint()}`);
  }
  return new Error(`GitHub API error: ${response.status} ${response.statusText}`);
}

async function githubFetch(url: string, allowLogin = true): Promise<Response> {
  const headers: Record<string, string> = { ...GITHUB_HEADERS, ...githubAuthHeaders() };
  const start = Date.now();
  const response = await fetch(url, { headers });
  const ms = Date.now() - start;
  await trace('api:github', { url, status: response.status, ms });
  if (!response.ok && allowLogin && canAutoLogin() && isAuthRecoverableStatus(response.status) && !getGitHubAuth()) {
    await loginWithGitHubApp(`GitHub returned ${response.status}`);
    return githubFetch(url, false);
  }
  if (!response.ok) {
    throw githubErrorFromStatus(response, url);
  }
  await maybePreemptiveLogin(response, allowLogin);
  return response;
}

async function githubDownload(url: string, allowLogin = true): Promise<Response> {
  const headers: Record<string, string> = githubAuthHeaders();
  const response = await fetch(url, { headers });
  if (!response.ok && allowLogin && canAutoLogin() && isAuthRecoverableStatus(response.status) && !getGitHubAuth()) {
    await loginWithGitHubApp(`GitHub download returned ${response.status}`);
    return githubDownload(url, false);
  }
  if (!response.ok) {
    throw new Error(`GitHub download error: ${response.status} ${response.statusText}${githubAuthHint()}`);
  }
  return response;
}

// ============================================================================
// Gist Fetching
// ============================================================================

interface GitHubGist {
  id: string;
  description: string;
  files: Record<string, { filename: string; content: string }>;
  history?: Array<{ version: string }>;
}

async function fetchGist(gistId: string, version?: string): Promise<GitHubGist> {
  const url = version
    ? githubApiUrl(`/gists/${gistId}/${version}`)
    : githubApiUrl(`/gists/${gistId}`);
  const response = await githubFetch(url);
  return response.json();
}

function gistToFiles(gist: GitHubGist): SourceFile[] {
  return sortFiles(Object.values(gist.files).map((f) => {
    const type = categorizeFile(f.filename);
    return {
      filename: f.filename,
      content: f.content,
      type,
      target: decodeGistFilename(f.filename),
      patchOrder: type === 'patch' ? getPatchOrder(f.filename) : undefined,
    };
  }));
}

// ============================================================================
// Repo Fetching
// ============================================================================

interface GitHubContentsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
  content?: string;
  encoding?: string;
}

async function fetchRepoFiles(
  owner: string, repo: string, path: string, ref: string, allowLogin = true,
): Promise<Array<{ path: string; content: FileContent }>> {
  const url = githubApiUrl(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  const response = await githubFetch(url, allowLogin);
  const data = await response.json();

  const files: Array<{ path: string; content: FileContent }> = [];

  if (!Array.isArray(data)) {
    if (data.content && data.encoding === 'base64') {
      files.push({ path: data.path, content: decodeFetchedContent(Buffer.from(data.content, 'base64')) });
    } else if (data.download_url) {
      const raw = await githubDownload(data.download_url);
      files.push({ path: data.path, content: decodeFetchedContent(Buffer.from(await raw.arrayBuffer())) });
    }
    return files;
  }

  for (const entry of data as GitHubContentsEntry[]) {
    if (entry.type === 'dir') {
      files.push(...await fetchRepoFiles(owner, repo, entry.path, ref, allowLogin));
    } else if (entry.type === 'file' && entry.download_url) {
      const raw = await githubDownload(entry.download_url);
      files.push({ path: entry.path, content: decodeFetchedContent(Buffer.from(await raw.arrayBuffer())) });
    }
  }

  return files;
}

async function fetchRepoCommitSha(owner: string, repo: string, ref: string): Promise<string> {
  const url = githubApiUrl(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  const response = await githubFetch(url);
  const data = await response.json();
  return data.sha;
}

async function fetchRepoDefaultBranch(owner: string, repo: string): Promise<string> {
  const response = await githubFetch(githubApiUrl(`/repos/${owner}/${repo}`));
  const data = await response.json();
  return data.default_branch;
}

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

// A commit SHA in a repo source URL is a baseline, not a pin: it records where
// the files came from (the manifest version), while pull/status check the
// repository's default branch for changes since then. Branch and tag refs
// resolve as themselves.
async function resolveRepoHeadSha(owner: string, repo: string, ref: string): Promise<string> {
  if (COMMIT_SHA_RE.test(ref)) {
    const branch = await fetchRepoDefaultBranch(owner, repo);
    return fetchRepoCommitSha(owner, repo, branch);
  }
  return fetchRepoCommitSha(owner, repo, ref);
}

function repoFilesToSourceFiles(rawFiles: Array<{ path: string; content: FileContent }>, basePath: string): SourceFile[] {
  // For single files, strip the directory portion so we get just the filename
  // For directories, strip basePath + '/' to get relative paths within the dir
  const isSingleFile = rawFiles.length === 1 && rawFiles[0].path === basePath;
  const prefix = isSingleFile
    ? (basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '')
    : (basePath ? basePath + '/' : '');
  return sortFiles(rawFiles.map((f) => {
    const relativePath = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
    const type = categorizeFile(relativePath);
    return {
      filename: basename(relativePath),
      content: f.content,
      type,
      target: relativePath,
      patchOrder: type === 'patch' ? getPatchOrder(relativePath) : undefined,
    };
  }));
}

// ============================================================================
// GitHub Compare API (repo only — rename tracking, efficient diffs)
// ============================================================================

interface CompareFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
}

interface CompareResult { files: CompareFile[] }

async function fetchRepoCompare(
  owner: string, repo: string, base: string, head: string,
): Promise<CompareResult> {
  const url = githubApiUrl(`/repos/${owner}/${repo}/compare/${base}...${head}`);
  const response = await githubFetch(url);
  return response.json();
}

// ============================================================================
// Single Commit API
// ============================================================================

async function fetchCommit(
  owner: string, repo: string, sha: string,
): Promise<{ sha: string; files: CompareFile[] }> {
  const url = githubApiUrl(`/repos/${owner}/${repo}/commits/${sha}`);
  const response = await githubFetch(url);
  const data = await response.json();
  return { sha: data.sha, files: data.files || [] };
}

// ============================================================================
// Pull Request API
// ============================================================================

interface PullRequestMeta {
  number: number;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  title: string;
}

async function fetchPullRequest(
  owner: string, repo: string, number: number,
): Promise<PullRequestMeta> {
  const url = githubApiUrl(`/repos/${owner}/${repo}/pulls/${number}`);
  const response = await githubFetch(url);
  const data = await response.json();
  return {
    number: data.number,
    base: { sha: data.base.sha, ref: data.base.ref },
    head: { sha: data.head.sha, ref: data.head.ref },
    title: data.title,
  };
}

// ============================================================================
// GitHub-hosted shadcn Registry Helpers
// ============================================================================

interface RegistryFile {
  path: string;
  content?: string;
  type: string;
  target?: string;
}

interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  files?: RegistryFile[];
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  envVars?: Record<string, string>;
  registryPath?: string;
}

interface RegistryDocument {
  include?: string[];
  items?: RegistryItem[];
}

interface RegistryRequirements {
  dependencies: string[];
  devDependencies: string[];
  registryDependencies: string[];
  envVars: Record<string, string>;
}

interface RegistryBundle {
  item: RegistryItem;
  files: SourceFile[];
  requirements: RegistryRequirements;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyRegistryRequirements(): RegistryRequirements {
  return { dependencies: [], devDependencies: [], registryDependencies: [], envVars: {} };
}

async function loadRegistryItems(
  owner: string,
  repo: string,
  ref: string,
  registryPath = 'registry.json',
  visited = new Set<string>(),
): Promise<RegistryItem[]> {
  if (visited.has(registryPath)) return [];
  visited.add(registryPath);

  const files = await fetchRepoFiles(owner, repo, registryPath, ref, false);
  if (files.length !== 1) {
    throw new Error(`Expected ${registryPath} to be a single registry file.`);
  }

  const registryRaw = files[0].content;
  const document = JSON.parse(typeof registryRaw === 'string' ? registryRaw : registryRaw.toString('utf-8')) as RegistryDocument;
  const items: RegistryItem[] = (document.items || []).map((item) => ({ ...item, registryPath }));

  for (const include of document.include || []) {
    const includePath = posix.normalize(posix.join(posix.dirname(registryPath), include));
    items.push(...await loadRegistryItems(owner, repo, ref, includePath, visited));
  }

  return items;
}

async function tryLoadRegistryItems(owner: string, repo: string, ref: string): Promise<RegistryItem[]> {
  try {
    return await loadRegistryItems(owner, repo, ref);
  } catch (error) {
    if ((error as Error).message.startsWith('Not found:')) return [];
    throw error;
  }
}

// posix.isAbsolute does not reject Windows drive-letter paths (C:/...), which
// the platform path module would treat as absolute at write time.
function hasDrivePrefix(value: string): boolean {
  return /^[A-Za-z]:/.test(value);
}

function normalizeRegistryTarget(target: string): string {
  const normalized = posix.normalize(target.replace(/\\/g, '/').replace(/^~\//, '').replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized) || hasDrivePrefix(normalized)) {
    throw new Error(`Registry target must stay within the project: ${target}`);
  }
  return normalized;
}

function resolveRegistryTarget(rootDir: string, file: RegistryFile): string {
  const target = normalizeRegistryTarget(file.target || file.path);
  const aliasMatch = target.match(/^@([^/]+)\/(.+)$/);
  if (!aliasMatch) return target;

  // When components.json can't resolve an alias, fall back to the alias name
  // as a plain directory (`@ui/button.tsx` -> `ui/button.tsx`). trackcn knows
  // nothing about any framework's conventions — a mechanically-placed file the
  // consumer's linter/agent can relocate beats a failed install.
  const fallback = normalizeRegistryTarget(join(aliasMatch[1], aliasMatch[2]));

  const componentsPath = join(rootDir, 'components.json');
  if (!existsSync(componentsPath)) return fallback;

  try {
    const config = JSON.parse(readFileSync(componentsPath, 'utf-8')) as {
      aliases?: Record<string, string>;
    };
    const alias = config.aliases?.[aliasMatch[1]];
    if (!alias) return fallback;
    return normalizeRegistryTarget(join(alias.replace(/^@\//, ''), aliasMatch[2]));
  } catch {
    // Malformed components.json shouldn't fail the install either.
    return fallback;
  }
}

async function resolveRegistryBundle(
  rootDir: string,
  owner: string,
  repo: string,
  ref: string,
  itemName: string,
  knownItems?: RegistryItem[],
): Promise<RegistryBundle | null> {
  const items = knownItems || await tryLoadRegistryItems(owner, repo, ref);
  const itemByName = new Map(items.map((item) => [item.name, item]));
  const rootItem = itemByName.get(itemName);
  if (!rootItem) return null;

  const requirements = emptyRegistryRequirements();
  const orderedItems: RegistryItem[] = [];
  const visited = new Set<string>();

  function visit(item: RegistryItem): void {
    if (visited.has(item.name)) return;
    visited.add(item.name);

    for (const dependency of item.registryDependencies || []) {
      const dependencyWithoutRef = dependency.split('#')[0];
      const localPrefix = `${owner}/${repo}/`;
      const localName = dependencyWithoutRef.startsWith(localPrefix)
        ? dependencyWithoutRef.slice(localPrefix.length)
        : dependencyWithoutRef;
      const localDependency = !dependency.includes('#') ? itemByName.get(localName) : undefined;
      if (localDependency) visit(localDependency);
      else requirements.registryDependencies.push(dependency);
    }

    orderedItems.push(item);
  }

  visit(rootItem);

  const filesByTarget = new Map<string, SourceFile>();
  for (const item of orderedItems) {
    requirements.dependencies.push(...(item.dependencies || []));
    requirements.devDependencies.push(...(item.devDependencies || []));
    Object.assign(requirements.envVars, item.envVars || {});

    for (const file of item.files || []) {
      let content: FileContent | undefined = file.content;
      if (content === undefined) {
        const sourcePath = posix.normalize(posix.join(posix.dirname(item.registryPath || 'registry.json'), file.path));
        const repoFiles = await fetchRepoFiles(owner, repo, sourcePath, ref);
        if (repoFiles.length !== 1) {
          throw new Error(`Expected registry file ${file.path} to resolve to one file.`);
        }
        content = repoFiles[0].content;
      }

      const target = resolveRegistryTarget(rootDir, file);
      filesByTarget.set(target, {
        filename: basename(target),
        content,
        type: 'regular',
        target,
      });
    }
  }

  requirements.dependencies = unique(requirements.dependencies);
  requirements.devDependencies = unique(requirements.devDependencies);
  requirements.registryDependencies = unique(requirements.registryDependencies);

  return { item: rootItem, files: [...filesByTarget.values()], requirements };
}

// ============================================================================
// trackcn.json Manifest
// ============================================================================

interface RepocnSource {
  url: string;
  version: string;
  files: Record<string, string>;
  'post-pull'?: string;
  type?: 'github-registry-item';
  owner?: string;
  repo?: string;
  item?: string;
  ref?: string;
  prefix?: string;
  ignore?: string[];
  requirements?: RegistryRequirements;
}

interface RepocnManifest { sources: RepocnSource[] }

function targetPath(rootDir: string, target: string): string {
  return isAbsolute(target) ? target : join(rootDir, target);
}

function normalizeSourceTarget(target: string): string {
  const normalized = posix.normalize(target.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized) || hasDrivePrefix(normalized)) {
    throw new Error(`Source file target must stay within its source: ${target}`);
  }
  return normalized;
}

function withDestination(prefix: string, target: string): string {
  const relativeTarget = normalizeSourceTarget(target);
  return prefix ? join(prefix, relativeTarget) : relativeTarget;
}

async function readManifest(rootDir: string): Promise<RepocnManifest | null> {
  const manifestPath = join(rootDir, 'trackcn.json');
  if (!existsSync(manifestPath)) return null;
  const raw = await readFile(manifestPath, 'utf-8');
  return JSON.parse(raw) as RepocnManifest;
}

async function writeManifest(rootDir: string, manifest: RepocnManifest): Promise<void> {
  const manifestPath = join(rootDir, 'trackcn.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function findSource(manifest: RepocnManifest, url: string, prefix: string): RepocnSource | undefined {
  return manifest.sources.find((s) => s.url === url && (s.prefix || '') === prefix);
}

function normalizeManifestPath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized) || hasDrivePrefix(normalized)) {
    throw new Error(`Path must stay within the project: ${value}`);
  }
  return normalized;
}

function globPatternToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (char === '*') {
      out += '[^/]*';
    } else {
      out += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeManifestPath(filePath);
  const normalizedPattern = normalizeManifestPath(pattern);
  if (normalizedPattern.includes('*')) return globPatternToRegExp(normalizedPattern).test(normalizedPath);
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function isIgnored(source: RepocnSource, filePath: string): boolean {
  return (source.ignore || []).some((pattern) => pathMatchesPattern(filePath, pattern));
}

function trackedFileEntries(source: RepocnSource): Array<[string, string]> {
  return Object.entries(source.files).filter(([filePath]) => !isIgnored(source, filePath));
}

function trackedFilePaths(source: RepocnSource): string[] {
  return trackedFileEntries(source).map(([filePath]) => filePath);
}

function filterIgnoredSourceFiles(source: RepocnSource, files: SourceFile[]): SourceFile[] {
  return files.filter((file) => !isIgnored(source, file.target));
}

// ============================================================================
// Staging: write patches/diffs to temp dir for callers to read
// ============================================================================

async function stagePatchFiles(
  files: SourceFile[],
): Promise<{ patches: Array<{ path: string; target: string }>; prompts: Array<{ path: string }> }> {
  const patches = files.filter((f) => f.type === 'patch');
  const prompts = files.filter((f) => f.type === 'prompt');
  if (patches.length === 0 && prompts.length === 0) return { patches: [], prompts: [] };

  const tempDir = join(tmpdir(), `trackcn-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });

  const patchRefs: Array<{ path: string; target: string }> = [];
  const promptRefs: Array<{ path: string }> = [];

  for (const file of patches) {
    const filePath = join(tempDir, 'patches', file.filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
    patchRefs.push({ path: filePath, target: file.target });
  }
  for (const file of prompts) {
    const filePath = join(tempDir, 'prompts', file.filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
    promptRefs.push({ path: filePath });
  }

  return { patches: patchRefs, prompts: promptRefs };
}

// ============================================================================
// Local Trace Logging
// ============================================================================

import { appendFile } from 'fs/promises';

const TRACE_DIR = process.env.TRACKCN_TRACE_DIR;
const TRACE_FILE = TRACE_DIR ? join(TRACE_DIR, 'trace.log') : null;

function redactSensitive(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key.toLowerCase().includes('hook') || key.toLowerCase().includes('postpull')) {
      return '[redacted command]';
    }
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]),
    );
  }
  return value;
}

async function trace(event: string, data?: Record<string, unknown>): Promise<void> {
  if (!TRACE_DIR || !TRACE_FILE) return;
  try {
    await mkdir(TRACE_DIR, { recursive: true });
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event,
      ...(redactSensitive(data) as Record<string, unknown>),
    });
    await appendFile(TRACE_FILE, entry + '\n');
  } catch { /* never block on trace failure */ }
}

// ============================================================================
// CLI: arg parsing
// ============================================================================

const VERSION = '0.7.0';

function showHelp() {
  console.log(`
trackcn - Sync files from GitHub into your codebase

Usage:
  trackcn add <url...> [directory]     Install files from GitHub gists or repos
  trackcn pull [--dry-run] [--force]   Update installed files from their sources
  trackcn status [--json]              Check if files are up to date
  trackcn remove <url> [--hard]        Untrack a source (--hard deletes files)
  trackcn auth [login|status|logout]   Manage GitHub login
  trackcn skills [list|get|path]        Load version-matched usage guides for agents

Start here (for AI agents):
  trackcn skills get trackcn

  Skills ship with the CLI (always version-matched) and include workflow
  patterns, safety rules, and copy-paste examples. Prefer this over guessing
  commands from flag docs alone.

  skills [list]                List available skills
  skills get trackcn             Core trackcn usage guide
  skills path [name]           Print skill directory path

Options:
  --json          Output JSON (all commands)
  --force         Overwrite locally modified files (add, pull)
  --hard          Delete tracked files from disk (remove)
  --dry-run       Show what would happen without writing (add, pull)
  --post-pull     Command to run after pulling updates (add)
  --help          Show this help
  --version       Show version

URL formats:
  owner/repo                                        Show install options and curated bundles
  owner/repo .                                      Install the complete repository
  owner/repo/item[#ref]                             Curated bundle or repository path
  owner/repo/tree/ref/path                          Directory or file from a repo
  owner/repo/blob/ref/path#L10-L20                  Specific lines from a file
  owner/repo/commit/<sha>                           Apply a single commit's changes
  owner/repo/compare/<base>...<head>                Apply a range of changes
  owner/repo/pull/<number>                          Apply a pull request's changes
  github.com/owner/repo/tree/ref/path               Directory or file from a repo
  github.com/owner/repo/tree/ref/path#branch/name   Explicit ref (for branch names with /)
  github.com/owner/repo/blob/ref/path#L10-L20       Specific lines from a file
  github.com/owner/repo/commit/<sha>                 Apply a single commit's changes
  github.com/owner/repo/compare/<base>...<head>      Apply a range of changes
  github.com/owner/repo/pull/<number>                Apply a pull request's changes
  gist.github.com/user/<id>                          Install files from a gist
  https://any-url.com/file.txt                       Fetch a raw file

Directory target (add only):
  If the last argument starts with . or /, it's the local directory.
  Trailing / derives subdirectory names from each URL's path.

Examples:
  trackcn add owner/repo
  trackcn add owner/repo .
  trackcn add owner/repo/project-conventions
  trackcn add anthropics/skills/skills/frontend-design ./.claude/skills/frontend-design
  trackcn add anthropics/skills/skills/frontend-design anthropics/skills/skills/pdf ./.claude/skills/
  trackcn add https://gist.github.com/user/abc123
  trackcn add https://github.com/owner/repo/commit/abc1234
  trackcn add https://github.com/owner/repo/pull/42
  trackcn add https://github.com/owner/repo/compare/v1.0...v2.0
  trackcn add https://github.com/owner/repo/blob/main/src/utils.ts#L10-L50
  trackcn auth login
  trackcn pull
  trackcn status --json
`);
}

const args = arg({
  '--json': Boolean,
  '--force': Boolean,
  '--hard': Boolean,
  '--dry-run': Boolean,
  '--post-pull': String,
  '--help': Boolean,
  '--version': Boolean,
});

const command = args._[0];
const positional = args._.slice(1);

if (args['--version']) {
  console.log(VERSION);
  process.exit(0);
}

if (args['--help'] || !command) {
  showHelp();
  process.exit(0);
}

const json = args['--json'] || false;

const colorEnabled = Boolean(process.env.FORCE_COLOR) || (!process.env.NO_COLOR && process.stdout.isTTY);

function ansi(code: string, value: string): string {
  return colorEnabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function muted(value: string): string {
  return ansi('2', value);
}

function statusCode(code: 'A' | 'M' | 'D' | 'C' | 'R' | '!'): string {
  const colors: Record<typeof code, string> = {
    // VS Code git decoration palette approximations:
    // added #81b88b, modified #e2c08d, deleted #c74e39.
    A: '1;38;2;129;184;139',
    M: '1;38;2;226;192;141',
    D: '1;38;2;199;78;57',
    C: '1;38;2;199;78;57',
    R: '1;38;2;115;201;239',
    '!': '1;38;2;226;192;141',
  };
  return ansi(colors[code], code);
}

function formatRefSuffix(ref: string): string {
  return ref ? muted(`@${ref}`) : '';
}

function shortRef(ref: string | undefined): string {
  if (!ref) return '';
  return /^[a-f0-9]{7,}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

function sourceLabel(url: string, version?: string): string {
  try {
    const parsed = parseUrl(url);
    if (parsed.type === 'repo') {
      const ref = shortRef(/^[a-f0-9]{7,}$/i.test(parsed.ref) ? parsed.ref : version || parsed.ref);
      return `${parsed.owner}/${parsed.repo}${formatRefSuffix(ref)}${parsed.path ? ` ${parsed.path}` : ''}`;
    }
    if (parsed.type === 'repo-shorthand') {
      const ref = shortRef(version || parsed.ref);
      return `${parsed.owner}/${parsed.repo}${formatRefSuffix(ref)}${parsed.path ? ` ${parsed.path}` : ''}`;
    }
    if (parsed.type === 'commit') return `${parsed.owner}/${parsed.repo}${formatRefSuffix(shortRef(parsed.sha))}`;
    if (parsed.type === 'commit-range') return `${parsed.owner}/${parsed.repo} ${shortRef(parsed.base)}...${shortRef(parsed.head)}`;
    if (parsed.type === 'pull') return `${parsed.owner}/${parsed.repo}#${parsed.number}`;
    if (parsed.type === 'gist') return `gist:${shortRef(parsed.gist)}`;
    if (parsed.type === 'raw') {
      const raw = new URL(parsed.url);
      return `${raw.hostname}${raw.pathname}`;
    }
  } catch {
    // Fall through to the original value if parsing fails.
  }
  return url;
}

// ============================================================================
// CLI: auth
// ============================================================================

async function cmdAuth(positional: string[]): Promise<void> {
  const [subcommand = 'status'] = positional;

  if (subcommand === 'login') {
    const auth = getGitHubAuth() || await loginWithGitHubApp();
    if (json) {
      console.log(JSON.stringify({ github: { authenticated: true, source: auth.source } }, null, 2));
    } else {
      console.log(`GitHub authenticated via ${auth.source}`);
    }
    return;
  }

  if (subcommand === 'status') {
    const auth = getGitHubAuth();
    if (json) {
      console.log(JSON.stringify({ github: { authenticated: Boolean(auth), source: auth?.source || null } }, null, 2));
    } else {
      console.log(auth ? `GitHub authenticated via ${auth.source}` : 'GitHub not authenticated');
    }
    return;
  }

  if (subcommand === 'logout') {
    try {
      await unlink(AUTH_PATH);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    cachedGitHubAuth = undefined;
    if (json) console.log(JSON.stringify({ github: { authenticated: false } }, null, 2));
    else console.log('GitHub login removed');
    return;
  }

  throw new Error(`Unknown auth command: ${subcommand}`);
}

// ============================================================================
// CLI: skills
// ============================================================================

interface BundledSkill {
  name: string;
  description: string;
}

const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: 'trackcn',
    description: 'Core trackcn usage guide. Read this before using trackcn to sync files or skills.',
  },
];

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

function showSkillsHelp(): void {
  console.error(`Usage:
  trackcn skills [list]
  trackcn skills get <name>
  trackcn skills path [name]`);
}

function failSkills(message: string): never {
  console.error(message);
  showSkillsHelp();
  process.exit(1);
}

function getBundledSkill(name: string | undefined): BundledSkill {
  if (!name) failSkills('Missing skill name.');
  const skill = BUNDLED_SKILLS.find((candidate) => candidate.name === name);
  if (!skill) failSkills(`Unknown skill: ${name}`);
  return skill;
}

async function cmdSkills(positional: string[]): Promise<void> {
  const [subcommand = 'list', name, ...extra] = positional;

  if (subcommand === 'list') {
    if (name || extra.length > 0) failSkills('Usage: trackcn skills [list]');

    if (json) {
      console.log(JSON.stringify({ skills: BUNDLED_SKILLS }, null, 2));
      return;
    }

    for (const skill of BUNDLED_SKILLS) {
      console.log(`  ${skill.name.padEnd(14)} ${skill.description}`);
    }
    return;
  }

  if (subcommand === 'get') {
    if (extra.length > 0) failSkills('Usage: trackcn skills get <name>');

    const skill = getBundledSkill(name);
    const path = join(SKILLS_DIR, skill.name, 'SKILL.md');
    const content = await readFile(path, 'utf8');

    if (json) {
      console.log(JSON.stringify({ ...skill, path, content }, null, 2));
      return;
    }

    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  if (subcommand === 'path') {
    if (extra.length > 0) failSkills('Usage: trackcn skills path [name]');

    const skill = name ? getBundledSkill(name) : undefined;
    const path = skill ? join(SKILLS_DIR, skill.name) : SKILLS_DIR;

    if (json) {
      console.log(JSON.stringify({ name: skill?.name, path }, null, 2));
      return;
    }

    console.log(path);
    return;
  }

  failSkills(`Unknown skills command: ${subcommand}`);
}

function registrySourceUrl(owner: string, repo: string, item: string, ref?: string): string {
  return `${owner}/${repo}/${item}${ref ? `#${ref}` : ''}`;
}

function isRegistrySource(source: RepocnSource): source is RepocnSource & {
  type: 'github-registry-item';
  owner: string;
  repo: string;
  item: string;
  ref: string;
} {
  return source.type === 'github-registry-item'
    && !!source.owner
    && !!source.repo
    && !!source.item
    && !!source.ref;
}

function showRepoMenu(
  owner: string,
  repo: string,
  defaultBranch: string,
  items: RegistryItem[],
): void {
  if (json) {
    console.log(JSON.stringify({
      repository: `${owner}/${repo}`,
      defaultBranch,
      installRepository: `trackcn add ${owner}/${repo} .`,
      installTree: `trackcn add ${owner}/${repo}/tree/${defaultBranch}/<path>`,
      installBlob: `trackcn add ${owner}/${repo}/blob/${defaultBranch}/<path>`,
      items: items.map((item) => ({
        name: item.name,
        title: item.title,
        description: item.description,
        command: `trackcn add ${owner}/${repo}/${item.name}`,
      })),
    }, null, 2));
    return;
  }

  console.log(`\n${owner}/${repo}\n`);
  console.log(`Install the complete repository:`);
  console.log(`  trackcn add ${owner}/${repo} .\n`);
  console.log(`Install a repository path:`);
  console.log(`  trackcn add ${owner}/${repo}/tree/${defaultBranch}/<path>`);
  console.log(`  trackcn add ${owner}/${repo}/blob/${defaultBranch}/<path>`);

  if (items.length > 0) {
    console.log(`\nCurated bundles:`);
    for (const item of items) {
      const description = item.description || item.title || '';
      console.log(`  ${item.name}${description ? `  ${description}` : ''}`);
    }
    console.log(`\nInstall a curated bundle:`);
    console.log(`  trackcn add ${owner}/${repo}/${items[0].name}`);
  }
  console.log('');
}

function printRegistryRequirements(requirements: RegistryRequirements): void {
  if (requirements.dependencies.length > 0) {
    console.log(`\n  Dependencies:`);
    for (const dependency of requirements.dependencies) console.log(`    ${dependency}`);
  }
  if (requirements.devDependencies.length > 0) {
    console.log(`\n  Dev dependencies:`);
    for (const dependency of requirements.devDependencies) console.log(`    ${dependency}`);
  }
  if (Object.keys(requirements.envVars).length > 0) {
    console.log(`\n  Environment variables:`);
    for (const name of Object.keys(requirements.envVars)) console.log(`    ${name}`);
  }
  if (requirements.registryDependencies.length > 0) {
    console.log(`\n  Additional registry dependencies:`);
    for (const dependency of requirements.registryDependencies) console.log(`    ${dependency}`);
  }
}

// ============================================================================
// CLI: add
// ============================================================================

async function cmdAdd(positional: string[]) {
  // Split positional: local paths (start with . or /) vs URLs
  const urls = positional.filter((a) => !isLocalPath(a));
  const directory = positional.find(isLocalPath);

  if (urls.length === 0) {
    console.error('Usage: trackcn add <url...> [directory]');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const dryRun = args['--dry-run'] || false;
  const postPull = args['--post-pull'];

  // Determine if directory target uses trailing / (derive names from URLs)
  const deriveNames = directory?.endsWith('/') || false;

  // For multiple URLs, require a directory with trailing /
  if (urls.length > 1 && directory && !deriveNames) {
    console.error('Multiple URLs require a directory target ending with / to derive subdirectory names.');
    process.exit(1);
  }

  const manifest: RepocnManifest = (await readManifest(rootDir)) || { sources: [] };
  let manifestChanged = false;
  const jsonResults: Array<Record<string, unknown>> = [];

  for (const url of urls) {
    let parsed: ParsedSource;
    try {
      parsed = parseUrl(url);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }

    let registryBundle: RegistryBundle | null = null;
    let registryOwner = '';
    let registryRepo = '';
    let registryItem = '';
    let registryRef = '';
    let shorthandFallback: { owner: string; repo: string; path: string } | null = null;

    if (parsed.type === 'repo-shorthand') {
      try {
        const defaultBranch = parsed.ref || await fetchRepoDefaultBranch(parsed.owner, parsed.repo);
        if (!parsed.path && !directory) {
          const items = await tryLoadRegistryItems(parsed.owner, parsed.repo, defaultBranch);
          showRepoMenu(parsed.owner, parsed.repo, defaultBranch, items);
          continue;
        }

        if (parsed.path) {
          registryBundle = await resolveRegistryBundle(
            rootDir,
            parsed.owner,
            parsed.repo,
            defaultBranch,
            parsed.path,
          );
        }

        if (registryBundle) {
          registryOwner = parsed.owner;
          registryRepo = parsed.repo;
          registryItem = parsed.path;
          registryRef = defaultBranch;
        } else {
          if (parsed.path) {
            shorthandFallback = { owner: parsed.owner, repo: parsed.repo, path: parsed.path };
          }
          parsed = {
            type: 'repo',
            owner: parsed.owner,
            repo: parsed.repo,
            ref: defaultBranch,
            path: parsed.path,
          };
        }
      } catch (error) {
        console.error('Failed to fetch:', (error as Error).message);
        process.exit(1);
      }
    }

    const sourceUrl = registryBundle
      ? registrySourceUrl(registryOwner, registryRepo, registryItem, parsed.type === 'repo-shorthand' ? parsed.ref : undefined)
      : canonicalUrl(parsed);

    if (!json) console.log(`\nFetching ${sourceUrl}...`);
    await trace('add:fetch', { url: sourceUrl });

    let files: SourceFile[] = [];
    // For repo sources: true only when the URL points at a file, not a
    // directory that happens to contain one file (which must still derive
    // subdirectory names and reject file-path targets).
    let repoSingleFile: boolean | null = null;
    let changesetFiles: CompareFile[] | null = null;
    let changesetOwner = '';
    let changesetRepo = '';
    let version: string;
    let description: string;

    try {
      if (registryBundle) {
        files = registryBundle.files;
        version = await fetchRepoCommitSha(registryOwner, registryRepo, registryRef);
        description = registryBundle.item.description
          || registryBundle.item.title
          || registrySourceUrl(registryOwner, registryRepo, registryItem);
      } else if (parsed.type === 'gist') {
        const gist = await fetchGist(parsed.gist);
        files = gistToFiles(gist);
        version = gist.history?.[0]?.version || '';
        description = gist.description || 'Unnamed gist';
      } else if (parsed.type === 'raw') {
        const response = await fetch(parsed.url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const content = decodeFetchedContent(Buffer.from(await response.arrayBuffer()));
        version = contentHash(content); // content hash IS the version
        files = [{
          filename: parsed.filename,
          content,
          type: 'regular' as FileType,
          target: parsed.filename,
        }];
        description = parsed.url;
      } else if (parsed.type === 'commit') {
        const commit = await fetchCommit(parsed.owner, parsed.repo, parsed.sha);
        changesetFiles = commit.files;
        changesetOwner = parsed.owner;
        changesetRepo = parsed.repo;
        version = commit.sha;
        description = `${parsed.owner}/${parsed.repo} commit ${parsed.sha.slice(0, 8)}`;
      } else if (parsed.type === 'commit-range') {
        const compare = await fetchRepoCompare(parsed.owner, parsed.repo, parsed.base, parsed.head);
        changesetFiles = compare.files;
        changesetOwner = parsed.owner;
        changesetRepo = parsed.repo;
        // Resolve head to a SHA if it's a branch name
        let headSha: string;
        try {
          headSha = await fetchRepoCommitSha(parsed.owner, parsed.repo, parsed.head);
        } catch {
          headSha = parsed.head;
        }
        version = headSha;
        description = `${parsed.owner}/${parsed.repo} ${parsed.base.slice(0, 8)}...${parsed.head}`;
      } else if (parsed.type === 'pull') {
        const pr = await fetchPullRequest(parsed.owner, parsed.repo, parsed.number);
        const compare = await fetchRepoCompare(parsed.owner, parsed.repo, pr.base.sha, pr.head.sha);
        changesetFiles = compare.files;
        changesetOwner = parsed.owner;
        changesetRepo = parsed.repo;
        version = pr.head.sha;
        description = `${parsed.owner}/${parsed.repo}#${parsed.number}: ${pr.title}`;
      } else if (parsed.type === 'repo') {
        const [rawFiles, commitSha] = await Promise.all([
          fetchRepoFiles(parsed.owner, parsed.repo, parsed.path, parsed.ref),
          fetchRepoCommitSha(parsed.owner, parsed.repo, parsed.ref),
        ]);
        // Line-range extraction
        if (parsed.startLine && rawFiles.length === 1) {
          if (typeof rawFiles[0].content !== 'string') {
            throw new Error('Line ranges (#L...) cannot be used with binary files.');
          }
          const lines = rawFiles[0].content.split('\n');
          const start = parsed.startLine - 1; // 0-indexed
          const end = parsed.endLine || parsed.startLine;
          rawFiles[0].content = lines.slice(start, end).join('\n') + '\n';
        } else if (parsed.startLine && rawFiles.length > 1) {
          throw new Error('Line range (#L...) can only be used with single file URLs, not directories.');
        }
        files = repoFilesToSourceFiles(rawFiles, parsed.path);
        repoSingleFile = rawFiles.length === 1 && rawFiles[0].path === parsed.path;
        version = commitSha;
        description = `${parsed.owner}/${parsed.repo}/${parsed.path}`;
      } else {
        throw new Error(`Cannot install unresolved repository shorthand: ${sourceUrl}`);
      }
    } catch (error) {
      console.error('Failed to fetch:', (error as Error).message);
      if (shorthandFallback) {
        console.error(`\n"${shorthandFallback.path}" is neither a registry item nor a repository path in ${shorthandFallback.owner}/${shorthandFallback.repo}.`);
        console.error(`Run \`trackcn add ${shorthandFallback.owner}/${shorthandFallback.repo}\` to list available registry items.`);
      }
      process.exit(1);
    }

    if (changesetFiles && changesetFiles.length >= 300) {
      console.error('This changeset reports 300 changed files — the GitHub API truncates at 300, so trackcn cannot apply it completely.');
      console.error('Narrow the commit range, or track the paths you need directly (trackcn add <owner>/<repo>/tree/<ref>/<path>).');
      process.exit(1);
    }

    // Compute prefix for this URL (after fetch so we know if it's a single file)
    let prefix = '';
    let fileTarget: string | null = null;
    if (directory) {
      const isChangeset = changesetFiles !== null;
      const isSingleFile = !isChangeset && !registryBundle && files.length === 1 && files[0].type === 'regular'
        && (repoSingleFile === null || repoSingleFile);
      // Target semantics: trailing / is always a directory, a basename with an
      // extension is a file path, anything else is a directory.
      const looksLikeFilePath = !deriveNames && extname(basename(directory)) !== '';
      if (looksLikeFilePath && isSingleFile) {
        fileTarget = directory.startsWith('./') ? directory.slice(2) : directory;
      } else if (looksLikeFilePath) {
        console.error(`Target "${directory}" looks like a file path, but the source is not a single file.`);
        console.error('Add a trailing slash to treat it as a directory (dots in directory names are fine).');
        process.exit(1);
      }
      // For raw URLs, always derive subdirectory from hostname (files share names like llms.txt)
      // For GitHub single files, skip derivation (you don't want a button.tsx/ directory)
      // Changesets always derive when trailing / is used
      const shouldDerive = deriveNames && (parsed.type === 'raw' || isChangeset || !isSingleFile);
      if (fileTarget) {
        prefix = dirname(fileTarget);
        files[0].target = basename(fileTarget);
      } else if (shouldDerive) {
        // Directory source + trailing /: derive subdirectory from URL's last path segment
        prefix = join(directory, lastPathSegment(parsed));
      } else {
        // Single file or explicit directory: use directory as-is
        prefix = directory;
      }
      // Normalize: strip leading ./
      if (prefix.startsWith('./')) prefix = prefix.slice(2);
      // Strip trailing /
      if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
      if (prefix === '.') prefix = '';
    }

    // Persist the destination mapping so future pulls resolve to the same files.
    for (const file of files) {
      file.target = withDestination(prefix, file.target);
    }

    const regular = files.filter((f) => f.type === 'regular');

    if (!json) console.log(`  ${description}`);

    let sourceEntry = findSource(manifest, sourceUrl, prefix);
    if (!sourceEntry) {
      sourceEntry = { url: sourceUrl, version, files: {}, ...(prefix ? { prefix } : {}) };
      manifest.sources.push(sourceEntry);
    } else {
      sourceEntry.version = version;
    }
    manifestChanged = true;

    if (registryBundle) {
      sourceEntry.type = 'github-registry-item';
      sourceEntry.owner = registryOwner;
      sourceEntry.repo = registryRepo;
      sourceEntry.item = registryItem;
      sourceEntry.ref = registryRef;
      sourceEntry.prefix = prefix || undefined;
      sourceEntry.requirements = registryBundle.requirements;
    }

    if (postPull) {
      sourceEntry['post-pull'] = postPull;
    }

    if (dryRun) {
      if (changesetFiles) {
        const cfFiles = changesetFiles.map((cf) => {
          const rel = withDestination(prefix, cf.filename);
          return `${cf.status === 'added' ? '+' : cf.status === 'removed' ? '-' : cf.status === 'renamed' ? '>' : '~'} ${rel}`;
        });
        if (json) {
          jsonResults.push({ source: sourceUrl, description, dryRun: true, changeset: cfFiles });
        } else {
          console.log(`\n  Would apply changeset:`);
          for (const f of cfFiles) console.log(`    ${f}`);
        }
      } else {
        if (json) {
          const staged = await stagePatchFiles(files);
          jsonResults.push({
            source: sourceUrl,
            description,
            dryRun: true,
            files: regular.map((f) => f.target),
            patches: staged.patches,
            prompts: staged.prompts,
            requirements: registryBundle?.requirements,
          });
        } else {
          if (regular.length > 0) {
            console.log(`\n  Would write:`);
            for (const file of regular) console.log(`    + ${file.target}`);
          }
          const staged = await stagePatchFiles(files);
          if (staged.patches.length > 0) {
            console.log(`\n  Patches (need agent):`);
            for (const p of staged.patches) console.log(`    ~ ${p.target}  ${p.path}`);
          }
          if (staged.prompts.length > 0) {
            console.log(`\n  Prompts (need agent):`);
            for (const p of staged.prompts) console.log(`    ? ${p.path}`);
          }
          if (registryBundle) printRegistryRequirements(registryBundle.requirements);
        }
      }
      continue;
    }

    // --- Changeset application path (commit, commit-range, pull) ---
    if (changesetFiles) {
      const force = args['--force'] || false;
      const written: string[] = [];
      const merged: string[] = [];
      const deleted: string[] = [];
      const renamed: string[] = [];
      const skippedAdd: string[] = [];

      for (const cf of changesetFiles) {
        const relativePath = withDestination(prefix, cf.filename);
        const fullPath = targetPath(rootDir, relativePath);

        if (cf.status === 'added') {
          const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
          if (rawFiles.length > 0) {
            const newHash = contentHash(rawFiles[0].content);
            if (existsSync(fullPath) && !force) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === newHash) {
                sourceEntry.files[relativePath] = newHash;
                written.push(relativePath);
              } else {
                skippedAdd.push(relativePath);
              }
            } else {
              await mkdir(dirname(fullPath), { recursive: true });
              await writeFile(fullPath, rawFiles[0].content);
              sourceEntry.files[relativePath] = newHash;
              written.push(relativePath);
            }
          }
        } else if (cf.status === 'modified' || cf.status === 'changed') {
          if (!existsSync(fullPath)) {
            // File doesn't exist locally — fetch full content and write
            const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
            if (rawFiles.length > 0) {
              await mkdir(dirname(fullPath), { recursive: true });
              await writeFile(fullPath, rawFiles[0].content);
              sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
              written.push(relativePath);
            }
          } else {
            const diskContent = await readFile(fullPath);
            const diskHash = contentHash(diskContent);
            const storedHash = sourceEntry.files[relativePath];
            const userModified = storedHash && diskHash !== storedHash;
            const diskText = asText(diskContent);

            if (!userModified || force) {
              const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
              if (rawFiles.length > 0) {
                await writeFile(fullPath, rawFiles[0].content);
                sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                written.push(relativePath);
              }
            } else if (cf.patch && diskText !== null) {
              const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
              const marked = addMergeMarker(diskText, cf.patch);
              if (marked.added) await writeFile(fullPath, marked.content);
              sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : diskHash;
              merged.push(relativePath);
            } else if (cf.patch) {
              skippedAdd.push(`${relativePath} (binary file conflict, use --force to overwrite)`);
            } else {
              skippedAdd.push(relativePath);
            }
          }
        } else if (cf.status === 'removed') {
          if (existsSync(fullPath)) {
            const storedHash = sourceEntry.files[relativePath];
            if (storedHash) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === storedHash || force) {
                await unlink(fullPath);
                delete sourceEntry.files[relativePath];
                deleted.push(relativePath);
              } else {
                skippedAdd.push(`${relativePath} (deleted upstream, modified locally)`);
              }
            }
          }
        } else if (cf.status === 'renamed') {
          const oldRelative = cf.previous_filename
            ? withDestination(prefix, cf.previous_filename)
            : relativePath;
          const oldPath = targetPath(rootDir, oldRelative);
          const newPath = fullPath;

          if (oldPath !== newPath && existsSync(newPath) && !force) {
            const targetStored = sourceEntry.files[relativePath];
            const targetHash = contentHash(await readFile(newPath));
            if (!targetStored || targetHash !== targetStored) {
              skippedAdd.push(`${relativePath} (rename target exists locally, use --force to overwrite)`);
              continue;
            }
          }

          if (existsSync(oldPath)) {
            const diskContent = await readFile(oldPath);
            const storedHash = sourceEntry.files[oldRelative];
            const userModified = storedHash && contentHash(diskContent) !== storedHash;
            const diskText = asText(diskContent);

            await mkdir(dirname(newPath), { recursive: true });

            if (cf.patch && userModified && !force && diskText === null) {
              skippedAdd.push(`${oldRelative} (binary file conflict, use --force to overwrite)`);
            } else if (cf.patch && userModified && !force) {
              const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
              await writeFile(newPath, addMergeMarker(diskText!, cf.patch).content);
              if (oldPath !== newPath) await unlink(oldPath);
              delete sourceEntry.files[oldRelative];
              sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : contentHash(diskContent);
              renamed.push(`${oldRelative} -> ${relativePath}`);
              merged.push(relativePath);
            } else if (cf.patch) {
              const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
              if (rawFiles.length > 0) {
                await writeFile(newPath, rawFiles[0].content);
                if (oldPath !== newPath) await unlink(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                renamed.push(`${oldRelative} -> ${relativePath}`);
                written.push(relativePath);
              }
            } else {
              await writeFile(newPath, diskContent);
              if (oldPath !== newPath) await unlink(oldPath);
              delete sourceEntry.files[oldRelative];
              sourceEntry.files[relativePath] = contentHash(diskContent);
              renamed.push(`${oldRelative} -> ${relativePath}`);
            }
          } else {
            // Old file doesn't exist locally, try to fetch new version
            const rawFiles = await fetchRepoFiles(changesetOwner, changesetRepo, cf.filename, version);
            if (rawFiles.length > 0) {
              await mkdir(dirname(newPath), { recursive: true });
              await writeFile(newPath, rawFiles[0].content);
              sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
              written.push(relativePath);
            }
          }
        }
      }

      if (json) {
        jsonResults.push({
          source: sourceUrl,
          description,
          added: written,
          merged,
          deleted,
          renamed,
          skipped: skippedAdd,
        });
      } else {
        if (written.length > 0) {
          console.log(`\n  Files:`);
          for (const path of written) console.log(`    + ${path}`);
        }
        if (renamed.length > 0) {
          console.log(`\n  Renamed:`);
          for (const path of renamed) console.log(`    > ${path}`);
        }
        if (merged.length > 0) {
          console.log(`\n  Merge markers added:`);
          for (const path of merged) console.log(`    M ${path}`);
        }
        if (deleted.length > 0) {
          console.log(`\n  Deleted:`);
          for (const path of deleted) console.log(`    - ${path}`);
        }
        if (skippedAdd.length > 0) {
          console.log(`\n  Skipped (file exists, use --force to overwrite):`);
          for (const path of skippedAdd) console.log(`    ! ${path}`);
        }
        console.log('');
      }
      continue;
    }

    // Write regular files with protection checks
    const force = args['--force'] || false;
    const written: string[] = [];
    const merged: string[] = [];
    const skippedAdd: string[] = [];
    for (const file of regular) {
      const fullPath = targetPath(rootDir, file.target);
      const newHash = contentHash(file.content);

      if (existsSync(fullPath)) {
        const diskContent = await readFile(fullPath);
        const diskHash = contentHash(diskContent);

        // File already has the right content — just update tracking
        if (diskHash === newHash) {
          sourceEntry.files[file.target] = newHash;
          await trace('add:file:unchanged', { path: file.target });
          written.push(file.target);
          continue;
        }

        // Check if this file is tracked by this source already
        const storedHash = sourceEntry.files[file.target];
        if (storedHash) {
          // Tracked by this source — is it modified?
          if (diskHash === storedHash || force) {
            // Unmodified or --force: safe to overwrite
            await writeFile(fullPath, file.content);
            sourceEntry.files[file.target] = newHash;
            await trace('add:file:overwrite', { path: file.target, force });
            written.push(file.target);
          } else {
            const diskText = asText(diskContent);
            const newText = asText(file.content);
            if (diskText === null || newText === null) {
              // Merge markers would corrupt binary files — leave the local
              // copy untouched and let the user decide.
              await trace('add:file:skip', { path: file.target, reason: 'binary_conflict' });
              skippedAdd.push(`${file.target} (binary file conflict, use --force to overwrite)`);
              continue;
            }
            if (hasMergeMarker(diskText)) {
              // A clean diff can't be computed against a file that still holds
              // an unresolved marker block — resolve first, then re-add.
              await trace('add:file:skip', { path: file.target, reason: 'unresolved_merge' });
              skippedAdd.push(`${file.target} (unresolved merge markers, resolve them first)`);
              continue;
            }
            // User modified — merge marker (base is the local file: at add
            // time there is no recorded old upstream version to diff from)
            const diff = DISK_BASE_NOTE + unifiedDiff(diskText, newText);
            await writeFile(fullPath, prependMergeMarker(diskText, diff));
            sourceEntry.files[file.target] = newHash;
            await trace('add:file:merge', { path: file.target });
            merged.push(file.target);
          }
        } else if (force) {
          // Not tracked by this source, but --force: overwrite
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, file.content);
          sourceEntry.files[file.target] = newHash;
          await trace('add:file:force', { path: file.target });
          written.push(file.target);
        } else {
          // File exists, not tracked by this source: skip to avoid data loss
          await trace('add:file:skip', { path: file.target, reason: 'exists_untracked' });
          skippedAdd.push(file.target);
        }
      } else {
        // New file — write it
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content);
        sourceEntry.files[file.target] = newHash;
        await trace('add:file:write', { path: file.target });
        written.push(file.target);
      }
    }

    // Stage patches/prompts to temp files for the caller to read
    const staged = await stagePatchFiles(files);

    if (json) {
      jsonResults.push({
        source: sourceUrl,
        description,
        added: written,
        merged,
        skipped: skippedAdd,
        patches: staged.patches,
        prompts: staged.prompts,
        requirements: registryBundle?.requirements,
      });
    } else {
      if (written.length > 0) {
        console.log(`\n  Files:`);
        for (const path of written) console.log(`    + ${path}`);
      }
      if (merged.length > 0) {
        console.log(`\n  Merge markers added:`);
        for (const path of merged) console.log(`    M ${path}`);
      }
      if (skippedAdd.length > 0) {
        console.log(`\n  Skipped (file exists, use --force to overwrite):`);
        for (const path of skippedAdd) console.log(`    ! ${path}`);
      }
      if (staged.patches.length > 0) {
        console.log(`\n  Patches (apply with an agent):`);
        for (const p of staged.patches) console.log(`    ~ ${p.target}  ${p.path}`);
      }
      if (staged.prompts.length > 0) {
        console.log(`\n  Prompts (execute with an agent):`);
        for (const p of staged.prompts) console.log(`    ? ${p.path}`);
      }
      if (registryBundle) printRegistryRequirements(registryBundle.requirements);
      console.log('');
    }
  }

  if (!dryRun && manifestChanged) await writeManifest(rootDir, manifest);

  if (json) console.log(JSON.stringify({ sources: jsonResults }, null, 2));

  await trace('add:done', { urls: urls.map((u) => { try { return canonicalUrl(parseUrl(u)); } catch { return u; } }), directory });
}

// ============================================================================
// CLI: pull
// ============================================================================

interface PullResults {
  updated: string[];
  added: string[];
  deleted: string[];
  renamed: string[];
  skipped: string[];
  merged: string[];
}

async function syncRefetchedFiles({
  rootDir,
  sourceEntry,
  files,
  force,
  dryRun,
  results,
  getOldText,
}: {
  rootDir: string;
  sourceEntry: RepocnSource;
  files: SourceFile[];
  force: boolean;
  dryRun: boolean;
  results: PullResults;
  // Returns the upstream content of a target at the source's recorded version,
  // so merge markers can carry the pure upstream diff (old -> new) instead of
  // a disk -> new diff that would present local edits as removals.
  getOldText?: (target: string) => Promise<string | null>;
}): Promise<{ anyChanges: boolean; deferred: boolean }> {
  let anyChanges = false;
  let deferred = false;
  const write = dryRun ? async (_path: string, _content: FileContent) => {} : writeFile;
  const remove = dryRun ? async (_path: string) => {} : unlink;
  const ensureDir = dryRun ? async (_path: string) => {} : (path: string) => mkdir(path, { recursive: true });
  const upstream = new Map(filterIgnoredSourceFiles(sourceEntry, files.filter((file) => file.type === 'regular')).map((file) => [file.target, file]));

  for (const trackedPath of Object.keys(sourceEntry.files)) {
    if (isIgnored(sourceEntry, trackedPath)) {
      delete sourceEntry.files[trackedPath];
      anyChanges = true;
    }
  }

  for (const [trackedPath, storedHash] of trackedFileEntries(sourceEntry)) {
    if (upstream.has(trackedPath)) continue;
    const fullPath = targetPath(rootDir, trackedPath);
    let removeTracking = !existsSync(fullPath);
    if (existsSync(fullPath)) {
      const diskHash = contentHash(await readFile(fullPath));
      if (diskHash === storedHash || force) {
        await remove(fullPath);
        results.deleted.push(trackedPath);
        anyChanges = true;
        removeTracking = true;
      } else {
        results.skipped.push(`${trackedPath} (deleted upstream, modified locally)`);
      }
    }
    if (removeTracking) delete sourceEntry.files[trackedPath];
  }

  for (const file of upstream.values()) {
    const fullPath = targetPath(rootDir, file.target);
    const newHash = contentHash(file.content);
    const storedHash = sourceEntry.files[file.target];

    if (!existsSync(fullPath)) {
      await ensureDir(dirname(fullPath));
      await write(fullPath, file.content);
      sourceEntry.files[file.target] = newHash;
      results.added.push(file.target);
      anyChanges = true;
      continue;
    }

    const diskContent = await readFile(fullPath);
    const diskHash = contentHash(diskContent);
    if (diskHash === newHash) {
      sourceEntry.files[file.target] = newHash;
      continue;
    }

    if (!storedHash && !force) {
      results.skipped.push(`${file.target} (added upstream, file exists locally)`);
      deferred = true;
      continue;
    }

    const userModified = !!storedHash && diskHash !== storedHash;
    const upstreamChanged = storedHash !== newHash;

    if (!userModified || force) {
      await write(fullPath, file.content);
      sourceEntry.files[file.target] = newHash;
      results.updated.push(file.target);
      anyChanges = true;
    } else if (upstreamChanged) {
      const diskText = asText(diskContent);
      const newText = asText(file.content);
      if (diskText === null || newText === null) {
        // Never splice merge markers into binary files — skip with a warning
        // and keep the old version so the change stays visible to later pulls.
        results.skipped.push(`${file.target} (binary file conflict, use --force to overwrite)`);
        deferred = true;
        continue;
      }
      const oldText = getOldText ? await getOldText(file.target) : null;
      if (oldText === null && hasMergeMarker(diskText)) {
        // Without old upstream content the diff base is the disk file, and the
        // disk file still holds an unresolved marker block — defer so the next
        // pull retries after the user resolves it.
        results.skipped.push(`${file.target} (unresolved merge markers, resolve and pull again)`);
        deferred = true;
        continue;
      }
      const diff = oldText === null
        ? DISK_BASE_NOTE + unifiedDiff(diskText, newText)
        : unifiedDiff(oldText, newText);
      const marked = addMergeMarker(diskText, diff);
      if (marked.added) {
        await write(fullPath, marked.content);
        results.merged.push(file.target);
        anyChanges = true;
      }
      sourceEntry.files[file.target] = newHash;
    }
  }

  return { anyChanges, deferred };
}

// When no old upstream content is available the marker diff is computed
// against the local file, so removed lines may be local edits rather than
// upstream removals — say so inside the block.
const DISK_BASE_NOTE = '(diff base: local file — upstream history unavailable; removed lines may be local edits)\n';

// Upstream 'added' a file that may already exist locally — never clobber an
// untracked or locally-modified file without --force.
async function writeUpstreamAddedFile({
  fullPath, relativePath, content, sourceEntry, force, results, write, ensureDir,
}: {
  fullPath: string;
  relativePath: string;
  content: FileContent;
  sourceEntry: RepocnSource;
  force: boolean;
  results: PullResults;
  write: (path: string, content: FileContent) => Promise<unknown>;
  ensureDir: (path: string) => Promise<unknown>;
}): Promise<{ changed: boolean; skipped: boolean }> {
  const newHash = contentHash(content);
  if (existsSync(fullPath) && !force) {
    const diskHash = contentHash(await readFile(fullPath));
    if (diskHash === newHash) {
      // Content already present — adopt tracking without writing.
      sourceEntry.files[relativePath] = newHash;
      return { changed: false, skipped: false };
    }
    const storedHash = sourceEntry.files[relativePath];
    if (!storedHash || diskHash !== storedHash) {
      results.skipped.push(`${relativePath} (added upstream, file exists locally)`);
      return { changed: false, skipped: true };
    }
  }
  await ensureDir(dirname(fullPath));
  await write(fullPath, content);
  sourceEntry.files[relativePath] = newHash;
  results.added.push(relativePath);
  return { changed: true, skipped: false };
}

async function cmdPull() {
    const rootDir = process.cwd();
    const manifest = await readManifest(rootDir);

    if (!manifest || manifest.sources.length === 0) {
      console.error('No trackcn.json found. Run `trackcn add <url>` first.');
      process.exit(1);
    }

    const force = args['--force'] || false;
    const dryRun = args['--dry-run'] || false;

    // In dry-run mode, skip all disk writes but keep detection logic
    const write = dryRun ? async (_p: string, _c: FileContent) => {} : writeFile;
    const remove = dryRun ? async (_p: string) => {} : unlink;
    const ensureDir = dryRun ? async (_p: string) => {} : (path: string) => mkdir(path, { recursive: true });

    if (!json) console.log(`\n${dryRun ? 'Previewing' : 'Pulling'} ${manifest.sources.length} source${manifest.sources.length === 1 ? '' : 's'}...`);

    const results: PullResults = {
      updated: [] as string[],
      added: [] as string[],
      deleted: [] as string[],
      renamed: [] as string[],
      skipped: [] as string[],
      merged: [] as string[],
    };

    const hooksToRun: string[] = [];
    const errors: Array<{ source: string; error: string }> = [];

    await trace('pull:start', { sources: manifest.sources.map((s) => s.url), force, dryRun });

    for (const sourceEntry of manifest.sources) {
      let anyChanges = false;

      if (isRegistrySource(sourceEntry)) {
        if (!json) console.log(`  ${sourceEntry.url}`);
        try {
          const latestSha = await fetchRepoCommitSha(sourceEntry.owner, sourceEntry.repo, sourceEntry.ref);
          if (latestSha === sourceEntry.version) continue;

          const bundle = await resolveRegistryBundle(
            rootDir,
            sourceEntry.owner,
            sourceEntry.repo,
            sourceEntry.ref,
            sourceEntry.item,
          );
          if (!bundle) throw new Error(`Registry item not found: ${sourceEntry.url}`);

          const prefix = sourceEntry.prefix || '';
          if (prefix) {
            for (const file of bundle.files) file.target = join(prefix, file.target);
          }

          // Old bundle content at the recorded version, resolved lazily and at
          // most once, so merge markers can carry the pure upstream diff.
          let oldBundleByTarget: Map<string, string | null> | null | undefined;
          const getOldText = async (target: string): Promise<string | null> => {
            if (oldBundleByTarget === undefined) {
              try {
                const oldBundle = await resolveRegistryBundle(
                  rootDir,
                  sourceEntry.owner,
                  sourceEntry.repo,
                  sourceEntry.version,
                  sourceEntry.item,
                );
                oldBundleByTarget = oldBundle
                  ? new Map(oldBundle.files.map((file) => [
                      prefix ? join(prefix, file.target) : file.target,
                      asText(file.content),
                    ]))
                  : null;
              } catch {
                oldBundleByTarget = null;
              }
            }
            return oldBundleByTarget?.get(target) ?? null;
          };

          const sync = await syncRefetchedFiles({
            rootDir,
            sourceEntry,
            files: bundle.files,
            force,
            dryRun,
            results,
            getOldText,
          });
          anyChanges = sync.anyChanges;
          if (!sync.deferred) sourceEntry.version = latestSha;
          sourceEntry.requirements = bundle.requirements;
        } catch (error) {
          const message = (error as Error).message;
          errors.push({ source: sourceEntry.url, error: message });
          if (!json) console.log(`    ERROR: ${message}`);
          continue;
        }
      } else {
        try {
        const parsed = parseUrl(sourceEntry.url);

      if (parsed.type === 'raw') {
        // --- Raw URL: re-fetch, compare content hash ---
        if (!json) console.log(`  ${sourceEntry.url}`);
        let content: FileContent;
        try {
          const response = await fetch(parsed.url);
          if (!response.ok) throw new Error(`${response.status}`);
          content = decodeFetchedContent(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          const message = (error as Error).message;
          errors.push({ source: sourceEntry.url, error: message });
          if (!json) console.log(`    ERROR: ${message}`);
          continue;
        }
        const newHash = contentHash(content);

        // For raw URLs, version IS the content hash
        if (newHash === sourceEntry.version) continue;

        // Single file — check each tracked file
        let rawDeferred = false;
        for (const [filePath, storedHash] of Object.entries(sourceEntry.files)) {
          const fullPath = targetPath(rootDir, filePath);
          if (!existsSync(fullPath)) {
            await ensureDir(dirname(fullPath));
            await write(fullPath, content);
            sourceEntry.files[filePath] = newHash;
            results.added.push(filePath);
            anyChanges = true;
          } else {
            const diskContent = await readFile(fullPath);
            const diskHash = contentHash(diskContent);
            const userModified = storedHash && diskHash !== storedHash;

            if (!userModified || force) {
              await write(fullPath, content);
              sourceEntry.files[filePath] = newHash;
              results.updated.push(filePath);
              anyChanges = true;
            } else {
              // Both sides changed — prepend merge marker with diff
              const diskText = asText(diskContent);
              const newText = asText(content);
              if (diskText === null || newText === null) {
                results.skipped.push(`${filePath} (binary file conflict, use --force to overwrite)`);
                rawDeferred = true;
                continue;
              }
              if (hasMergeMarker(diskText)) {
                // Raw URLs have no history, so the diff base is the disk file —
                // unusable while an unresolved marker block is present. Defer
                // (keep the old version) so the next pull retries.
                results.skipped.push(`${filePath} (unresolved merge markers, resolve and pull again)`);
                rawDeferred = true;
                continue;
              }
              const diff = DISK_BASE_NOTE + unifiedDiff(diskText, newText);
              await write(fullPath, prependMergeMarker(diskText, diff));
              sourceEntry.files[filePath] = newHash;
              results.merged.push(filePath);
              anyChanges = true;
            }
          }
        }

        if (!rawDeferred) sourceEntry.version = newHash;

      } else if (parsed.type === 'repo') {
        const latestSha = await resolveRepoHeadSha(parsed.owner, parsed.repo, parsed.ref);
        if (!json) console.log(`  ${sourceEntry.url}`);

        if (latestSha === sourceEntry.version) continue;

        const trackedKeys = Object.keys(sourceEntry.files);

        // Refetch the tracked path and run the three-hash sync against it.
        // Handles everything the Compare API can't: single files (its file
        // list is directory-oriented), truncated compares (capped at 300
        // files), and force-pushed bases (compare 404s).
        const fullRefetchSync = async () => {
          let rawFiles: Array<{ path: string; content: FileContent }> = [];
          try {
            // Fetch at the resolved head so content matches the recorded version
            rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, parsed.path, latestSha);
          } catch (error) {
            // Only an explicit 404 means the path is gone upstream (deleted or
            // renamed) — then syncing against an empty upstream is correct:
            // unmodified tracked files delete, modified ones skip. Any other
            // failure (rate limit, network) must abort the source, or the
            // empty result would be read as "everything deleted upstream".
            if (!(error as Error).message.startsWith('Not found:')) throw error;
            if (!json) console.log(`    (path not found upstream — removed or renamed)`);
          }
          if (parsed.startLine && rawFiles.length === 1 && typeof rawFiles[0].content === 'string') {
            const lines = rawFiles[0].content.split('\n');
            rawFiles[0].content = lines.slice(parsed.startLine - 1, parsed.endLine || parsed.startLine).join('\n') + '\n';
          }
          const files = repoFilesToSourceFiles(rawFiles, parsed.path);
          const isSingleFile = rawFiles.length === 1 && rawFiles[0].path === parsed.path && trackedKeys.length === 1;
          if (isSingleFile) {
            // True single file: keep the tracked destination (supports file renames on add)
            files[0].target = trackedKeys[0];
          } else {
            for (const file of files) file.target = withDestination(sourceEntry.prefix || '', file.target);
          }

          const oldVersion = sourceEntry.version;
          const getOldText = async (target: string): Promise<string | null> => {
            if (!oldVersion) return null;
            try {
              let upstreamPath: string;
              if (isSingleFile) {
                upstreamPath = parsed.path;
              } else {
                const destPrefix = sourceEntry.prefix || '';
                const rel = destPrefix && target.startsWith(`${destPrefix}/`) ? target.slice(destPrefix.length + 1) : target;
                upstreamPath = parsed.path ? `${parsed.path}/${rel}` : rel;
              }
              const old = await fetchRepoFiles(parsed.owner, parsed.repo, upstreamPath, oldVersion, false);
              if (old.length !== 1) return null;
              let text = asText(old[0].content);
              if (text !== null && parsed.startLine) {
                const lines = text.split('\n');
                text = lines.slice(parsed.startLine - 1, parsed.endLine || parsed.startLine).join('\n') + '\n';
              }
              return text;
            } catch {
              return null;
            }
          };

          const sync = await syncRefetchedFiles({ rootDir, sourceEntry, files, force, dryRun, results, getOldText });
          anyChanges = sync.anyChanges;
          if (!sync.deferred) sourceEntry.version = latestSha;
          if (anyChanges && sourceEntry['post-pull']) hooksToRun.push(sourceEntry['post-pull']);
        };

        // Line ranges always refetch (slicing can't be derived from diffs), and
        // single-tracked-file sources refetch because compare filtering is
        // directory-oriented — refetching one file is a single request anyway.
        if (parsed.startLine || trackedKeys.length === 1) {
          await fullRefetchSync();
          continue;
        }

        let compare: CompareResult | null = null;
        try {
          compare = await fetchRepoCompare(parsed.owner, parsed.repo, sourceEntry.version, latestSha);
        } catch {
          if (!json) console.log(`    (compare failed, doing full refetch)`);
        }
        // GitHub truncates compare results at 300 files with no pagination —
        // applying a truncated compare silently drops changes, so refetch.
        if (compare && compare.files.length >= 300) {
          if (!json) console.log(`    (compare truncated at 300 files, doing full refetch)`);
          compare = null;
        }
        if (!compare) {
          await fullRefetchSync();
          continue;
        }

        const prefix = parsed.path ? parsed.path + '/' : '';
        const relevantFiles = compare.files.filter(
          (f) => f.filename.startsWith(prefix) || (f.previous_filename && f.previous_filename.startsWith(prefix))
        );

        // Skips that leave an upstream change unapplied (collisions, binary
        // conflicts) keep the old version so later pulls — including
        // `pull --force` — can still apply it.
        let sourceDeferred = false;

        for (const cf of relevantFiles) {
          const sourceRelativePath = cf.filename.startsWith(prefix) ? cf.filename.slice(prefix.length) : cf.filename;
          const relativePath = withDestination(sourceEntry.prefix || '', sourceRelativePath);
          if (isIgnored(sourceEntry, relativePath)) continue;

          if (cf.status === 'added') {
            const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
            if (rawFiles.length > 0) {
              const fullPath = targetPath(rootDir, relativePath);
              const added = await writeUpstreamAddedFile({ fullPath, relativePath, content: rawFiles[0].content, sourceEntry, force, results, write, ensureDir });
              if (added.changed) anyChanges = true;
              if (added.skipped) sourceDeferred = true;
            }
          } else if (cf.status === 'removed') {
            const fullPath = targetPath(rootDir, relativePath);
            const storedHash = sourceEntry.files[relativePath];
            if (existsSync(fullPath) && storedHash) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === storedHash || force) {
                await remove(fullPath);
                delete sourceEntry.files[relativePath];
                results.deleted.push(relativePath);
                anyChanges = true;
              } else {
                results.skipped.push(`${relativePath} (deleted upstream, modified locally)`);
              }
            } else {
              delete sourceEntry.files[relativePath];
            }
          } else if (cf.status === 'renamed') {
            const oldSourceRelative = cf.previous_filename
              ? (cf.previous_filename.startsWith(prefix) ? cf.previous_filename.slice(prefix.length) : cf.previous_filename)
              : sourceRelativePath;
            const oldRelative = withDestination(sourceEntry.prefix || '', oldSourceRelative);
            const oldPath = targetPath(rootDir, oldRelative);
            const newPath = targetPath(rootDir, relativePath);

            if (oldPath !== newPath && existsSync(newPath) && !force) {
              const targetStored = sourceEntry.files[relativePath];
              const targetHash = contentHash(await readFile(newPath));
              if (!targetStored || targetHash !== targetStored) {
                results.skipped.push(`${relativePath} (rename target exists locally, use --force to overwrite)`);
                sourceDeferred = true;
                continue;
              }
            }

            if (existsSync(oldPath)) {
              const diskContent = await readFile(oldPath);
              const storedHash = sourceEntry.files[oldRelative];
              const userModified = storedHash && contentHash(diskContent) !== storedHash;
              const diskText = asText(diskContent);

              await ensureDir(dirname(newPath));

              if (cf.patch && userModified && !force && diskText === null) {
                results.skipped.push(`${oldRelative} (binary file conflict, use --force to overwrite)`);
                sourceDeferred = true;
              } else if (cf.patch && userModified && !force) {
                // Fetch before writing the marker so a failed fetch can't leave
                // a marker on disk with a stale manifest.
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
                await write(newPath, addMergeMarker(diskText!, cf.patch).content);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                results.merged.push(relativePath);
                anyChanges = true;
              } else if (cf.patch) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
                if (rawFiles.length > 0) {
                  await write(newPath, rawFiles[0].content);
                  if (oldPath !== newPath) await remove(oldPath);
                  delete sourceEntry.files[oldRelative];
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.renamed.push(`${oldRelative} -> ${relativePath}`);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else {
                await write(newPath, diskContent);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                anyChanges = true;
              }
            }
          } else if (cf.status === 'modified' || cf.status === 'changed') {
            const fullPath = targetPath(rootDir, relativePath);
            const storedHash = sourceEntry.files[relativePath];

            if (!existsSync(fullPath)) {
              const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
              if (rawFiles.length > 0) {
                await ensureDir(dirname(fullPath));
                await write(fullPath, rawFiles[0].content);
                sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                results.added.push(relativePath);
                anyChanges = true;
              }
            } else {
              const diskHash = contentHash(await readFile(fullPath));
              const userModified = storedHash && diskHash !== storedHash;

              if (!userModified || force) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
                if (rawFiles.length > 0) {
                  await write(fullPath, rawFiles[0].content);
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else if (cf.patch) {
                const diskText = asText(await readFile(fullPath));
                if (diskText === null) {
                  results.skipped.push(`${relativePath} (binary file conflict, use --force to overwrite)`);
                  sourceDeferred = true;
                  continue;
                }
                // Fetch before writing the marker so a failed fetch can't leave
                // a marker on disk with a stale manifest.
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestSha);
                const marked = addMergeMarker(diskText, cf.patch);
                if (marked.added) {
                  await write(fullPath, marked.content);
                  results.merged.push(relativePath);
                  anyChanges = true;
                }
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : storedHash;
              } else {
                results.skipped.push(relativePath);
              }
            }
          }
        }

        if (!sourceDeferred) sourceEntry.version = latestSha;

      } else if (parsed.type === 'commit') {
        // --- Commit: immutable, nothing to pull ---
        if (!json) console.log(`  ${sourceEntry.url}`);
        // Nothing to do — commits don't change

      } else if (parsed.type === 'commit-range') {
        // --- Commit range: head may be a branch name ---
        if (!json) console.log(`  ${sourceEntry.url}`);
        let latestHead: string;
        try {
          latestHead = await fetchRepoCommitSha(parsed.owner, parsed.repo, parsed.head);
        } catch {
          latestHead = parsed.head;
        }
        if (latestHead === sourceEntry.version) continue;

        const compare = await fetchRepoCompare(parsed.owner, parsed.repo, sourceEntry.version, latestHead);
        if (compare.files.length >= 300) {
          errors.push({ source: sourceEntry.url, error: 'compare reports 300 changed files (GitHub truncates at 300) — skipping to avoid a partial update. Narrow the range or re-add the source.' });
          continue;
        }
        let sourceDeferred = false;
        for (const cf of compare.files) {
          const relativePath = withDestination(sourceEntry.prefix || '', cf.filename);
          if (isIgnored(sourceEntry, relativePath)) continue;
          const fullPath = targetPath(rootDir, relativePath);

          if (cf.status === 'added') {
            const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
            if (rawFiles.length > 0) {
              const added = await writeUpstreamAddedFile({ fullPath, relativePath, content: rawFiles[0].content, sourceEntry, force, results, write, ensureDir });
              if (added.changed) anyChanges = true;
              if (added.skipped) sourceDeferred = true;
            }
          } else if (cf.status === 'removed') {
            const storedHash = sourceEntry.files[relativePath];
            if (existsSync(fullPath) && storedHash) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === storedHash || force) {
                await remove(fullPath);
                delete sourceEntry.files[relativePath];
                results.deleted.push(relativePath);
                anyChanges = true;
              } else {
                results.skipped.push(`${relativePath} (deleted upstream, modified locally)`);
              }
            }
          } else if (cf.status === 'renamed') {
            const oldRelative = withDestination(sourceEntry.prefix || '', cf.previous_filename || cf.filename);
            const oldPath = targetPath(rootDir, oldRelative);
            const newPath = fullPath;

            if (oldPath !== newPath && existsSync(newPath) && !force) {
              const targetStored = sourceEntry.files[relativePath];
              const targetHash = contentHash(await readFile(newPath));
              if (!targetStored || targetHash !== targetStored) {
                results.skipped.push(`${relativePath} (rename target exists locally, use --force to overwrite)`);
                sourceDeferred = true;
                continue;
              }
            }

            if (existsSync(oldPath)) {
              const diskContent = await readFile(oldPath);
              const storedHash = sourceEntry.files[oldRelative];
              const userModified = storedHash && contentHash(diskContent) !== storedHash;
              const diskText = asText(diskContent);

              await ensureDir(dirname(newPath));

              if (cf.patch && userModified && !force && diskText === null) {
                results.skipped.push(`${oldRelative} (binary file conflict, use --force to overwrite)`);
                sourceDeferred = true;
              } else if (cf.patch && userModified && !force) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
                await write(newPath, addMergeMarker(diskText!, cf.patch).content);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                results.merged.push(relativePath);
                anyChanges = true;
              } else if (cf.patch) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
                if (rawFiles.length > 0) {
                  await write(newPath, rawFiles[0].content);
                  if (oldPath !== newPath) await remove(oldPath);
                  delete sourceEntry.files[oldRelative];
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.renamed.push(`${oldRelative} -> ${relativePath}`);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else {
                await write(newPath, diskContent);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                anyChanges = true;
              }
            }
          } else if (cf.status === 'modified' || cf.status === 'changed') {
            if (!existsSync(fullPath)) {
              const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
              if (rawFiles.length > 0) {
                await ensureDir(dirname(fullPath));
                await write(fullPath, rawFiles[0].content);
                sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                results.added.push(relativePath);
                anyChanges = true;
              }
            } else {
              const diskHash = contentHash(await readFile(fullPath));
              const storedHash = sourceEntry.files[relativePath];
              const userModified = storedHash && diskHash !== storedHash;

              if (!userModified || force) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
                if (rawFiles.length > 0) {
                  await write(fullPath, rawFiles[0].content);
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else if (cf.patch) {
                const diskText = asText(await readFile(fullPath));
                if (diskText === null) {
                  results.skipped.push(`${relativePath} (binary file conflict, use --force to overwrite)`);
                  sourceDeferred = true;
                  continue;
                }
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHead);
                const marked = addMergeMarker(diskText, cf.patch);
                if (marked.added) {
                  await write(fullPath, marked.content);
                  results.merged.push(relativePath);
                  anyChanges = true;
                }
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : storedHash;
              } else {
                results.skipped.push(relativePath);
              }
            }
          }
        }

        if (!sourceDeferred) sourceEntry.version = latestHead;

      } else if (parsed.type === 'pull') {
        // --- Pull request: check for new commits ---
        if (!json) console.log(`  ${sourceEntry.url}`);
        const pr = await fetchPullRequest(parsed.owner, parsed.repo, parsed.number);
        const latestHeadSha = pr.head.sha;

        if (latestHeadSha === sourceEntry.version) continue;

        const compare = await fetchRepoCompare(parsed.owner, parsed.repo, sourceEntry.version, latestHeadSha);
        if (compare.files.length >= 300) {
          errors.push({ source: sourceEntry.url, error: 'compare reports 300 changed files (GitHub truncates at 300) — skipping to avoid a partial update. Narrow the range or re-add the source.' });
          continue;
        }
        let sourceDeferred = false;
        for (const cf of compare.files) {
          const relativePath = withDestination(sourceEntry.prefix || '', cf.filename);
          if (isIgnored(sourceEntry, relativePath)) continue;
          const fullPath = targetPath(rootDir, relativePath);

          if (cf.status === 'added') {
            const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
            if (rawFiles.length > 0) {
              const added = await writeUpstreamAddedFile({ fullPath, relativePath, content: rawFiles[0].content, sourceEntry, force, results, write, ensureDir });
              if (added.changed) anyChanges = true;
              if (added.skipped) sourceDeferred = true;
            }
          } else if (cf.status === 'removed') {
            const storedHash = sourceEntry.files[relativePath];
            if (existsSync(fullPath) && storedHash) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === storedHash || force) {
                await remove(fullPath);
                delete sourceEntry.files[relativePath];
                results.deleted.push(relativePath);
                anyChanges = true;
              } else {
                results.skipped.push(`${relativePath} (deleted upstream, modified locally)`);
              }
            }
          } else if (cf.status === 'renamed') {
            const oldRelative = withDestination(sourceEntry.prefix || '', cf.previous_filename || cf.filename);
            const oldPath = targetPath(rootDir, oldRelative);
            const newPath = fullPath;

            if (oldPath !== newPath && existsSync(newPath) && !force) {
              const targetStored = sourceEntry.files[relativePath];
              const targetHash = contentHash(await readFile(newPath));
              if (!targetStored || targetHash !== targetStored) {
                results.skipped.push(`${relativePath} (rename target exists locally, use --force to overwrite)`);
                sourceDeferred = true;
                continue;
              }
            }

            if (existsSync(oldPath)) {
              const diskContent = await readFile(oldPath);
              const storedHash = sourceEntry.files[oldRelative];
              const userModified = storedHash && contentHash(diskContent) !== storedHash;
              const diskText = asText(diskContent);

              await ensureDir(dirname(newPath));

              if (cf.patch && userModified && !force && diskText === null) {
                results.skipped.push(`${oldRelative} (binary file conflict, use --force to overwrite)`);
                sourceDeferred = true;
              } else if (cf.patch && userModified && !force) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
                await write(newPath, addMergeMarker(diskText!, cf.patch).content);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                results.merged.push(relativePath);
                anyChanges = true;
              } else if (cf.patch) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
                if (rawFiles.length > 0) {
                  await write(newPath, rawFiles[0].content);
                  if (oldPath !== newPath) await remove(oldPath);
                  delete sourceEntry.files[oldRelative];
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.renamed.push(`${oldRelative} -> ${relativePath}`);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else {
                await write(newPath, diskContent);
                if (oldPath !== newPath) await remove(oldPath);
                delete sourceEntry.files[oldRelative];
                sourceEntry.files[relativePath] = contentHash(diskContent);
                results.renamed.push(`${oldRelative} -> ${relativePath}`);
                anyChanges = true;
              }
            }
          } else if (cf.status === 'modified' || cf.status === 'changed') {
            if (!existsSync(fullPath)) {
              const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
              if (rawFiles.length > 0) {
                await ensureDir(dirname(fullPath));
                await write(fullPath, rawFiles[0].content);
                sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                results.added.push(relativePath);
                anyChanges = true;
              }
            } else {
              const diskHash = contentHash(await readFile(fullPath));
              const storedHash = sourceEntry.files[relativePath];
              const userModified = storedHash && diskHash !== storedHash;

              if (!userModified || force) {
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
                if (rawFiles.length > 0) {
                  await write(fullPath, rawFiles[0].content);
                  sourceEntry.files[relativePath] = contentHash(rawFiles[0].content);
                  results.updated.push(relativePath);
                  anyChanges = true;
                }
              } else if (cf.patch) {
                const diskText = asText(await readFile(fullPath));
                if (diskText === null) {
                  results.skipped.push(`${relativePath} (binary file conflict, use --force to overwrite)`);
                  sourceDeferred = true;
                  continue;
                }
                const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, cf.filename, latestHeadSha);
                const marked = addMergeMarker(diskText, cf.patch);
                if (marked.added) {
                  await write(fullPath, marked.content);
                  results.merged.push(relativePath);
                  anyChanges = true;
                }
                sourceEntry.files[relativePath] = rawFiles.length > 0 ? contentHash(rawFiles[0].content) : storedHash;
              } else {
                results.skipped.push(relativePath);
              }
            }
          }
        }

        if (!sourceDeferred) sourceEntry.version = latestHeadSha;

      } else if (parsed.type === 'gist') {
        // --- Gist ---
        const gist = await fetchGist(parsed.gist);
        const latestVersion = gist.history?.[0]?.version || '';
        if (!json) console.log(`  ${sourceEntry.url}`);

        if (latestVersion === sourceEntry.version) continue;

        const files = gistToFiles(gist);
        for (const file of files) file.target = withDestination(sourceEntry.prefix || '', file.target);
        const regular = filterIgnoredSourceFiles(sourceEntry, files.filter((f) => f.type === 'regular'));

        let oldFiles: SourceFile[] = [];
        if (sourceEntry.version) {
          try {
            const oldGist = await fetchGist(parsed.gist, sourceEntry.version);
            oldFiles = gistToFiles(oldGist).filter((f) => f.type === 'regular');
            for (const file of oldFiles) file.target = withDestination(sourceEntry.prefix || '', file.target);
          } catch { /* can't get old version */ }
        }

        // Check for files removed upstream
        let gistDeferred = false;
        const upstreamTargets = new Set(regular.map((f) => f.target));
        for (const trackedPath of trackedFilePaths(sourceEntry)) {
          if (!upstreamTargets.has(trackedPath)) {
            const fullPath = targetPath(rootDir, trackedPath);
            const storedHash = sourceEntry.files[trackedPath];
            let removeTracking = !existsSync(fullPath);
            if (existsSync(fullPath)) {
              const diskHash = contentHash(await readFile(fullPath));
              if (diskHash === storedHash || force) {
                await remove(fullPath);
                results.deleted.push(trackedPath);
                anyChanges = true;
                removeTracking = true;
              } else {
                results.skipped.push(`${trackedPath} (deleted upstream, modified locally)`);
              }
            }
            if (removeTracking) delete sourceEntry.files[trackedPath];
          }
        }

        for (const file of regular) {
          const fullPath = targetPath(rootDir, file.target);
          const newHash = contentHash(file.content);
          const storedHash = sourceEntry.files[file.target];

          if (!existsSync(fullPath)) {
            await ensureDir(dirname(fullPath));
            await write(fullPath, file.content);
            sourceEntry.files[file.target] = newHash;
            results.added.push(file.target);
            anyChanges = true;
            continue;
          }

          const diskContent = await readFile(fullPath);
          const diskHash = contentHash(diskContent);

          if (diskHash === newHash) {
            sourceEntry.files[file.target] = newHash;
            continue;
          }

          const userModified = storedHash && diskHash !== storedHash;
          const upstreamChanged = storedHash !== newHash;

          if (!userModified) {
            await write(fullPath, file.content);
            sourceEntry.files[file.target] = newHash;
            results.updated.push(file.target);
            anyChanges = true;
          } else if (!upstreamChanged) {
            // only user changed, upstream same — nothing to do
          } else if (force) {
            await write(fullPath, file.content);
            sourceEntry.files[file.target] = newHash;
            results.updated.push(file.target);
            anyChanges = true;
          } else {
            // Three-way merge — compute diff from old to new, prepend marker
            const oldFile = oldFiles.find((f) => f.target === file.target);
            const diskText = asText(diskContent);
            const newText = asText(file.content);
            const oldText = oldFile ? asText(oldFile.content) : null;
            if (diskText === null || newText === null) {
              results.skipped.push(`${file.target} (binary file conflict, use --force to overwrite)`);
              gistDeferred = true;
            } else if (oldText === null && hasMergeMarker(diskText)) {
              // No clean diff base while an unresolved marker block is present —
              // defer (keep the old version) so the next pull retries.
              results.skipped.push(`${file.target} (unresolved merge markers, resolve and pull again)`);
              gistDeferred = true;
            } else {
              const diff = oldText === null
                ? DISK_BASE_NOTE + unifiedDiff(diskText, newText)
                : unifiedDiff(oldText, newText);
              const marked = addMergeMarker(diskText, diff);
              if (marked.added) {
                await write(fullPath, marked.content);
                results.merged.push(file.target);
                anyChanges = true;
              }
              sourceEntry.files[file.target] = newHash;
            }
          }
        }

        if (!gistDeferred) sourceEntry.version = latestVersion;
      } else {
        throw new Error(`Unsupported source: ${sourceEntry.url}`);
      }
        } catch (error) {
          // One failing source must not abort the whole pull — files already
          // written for this source stay recorded in the manifest, and the
          // version stays put so the next pull picks up where this one failed.
          const message = (error as Error).message;
          errors.push({ source: sourceEntry.url, error: message });
          if (!json) console.log(`    ERROR: ${message}`);
          continue;
        }
      }

      if (anyChanges && sourceEntry['post-pull']) {
        hooksToRun.push(sourceEntry['post-pull']);
      }
    }

    await trace('pull:done', { added: results.added, updated: results.updated, deleted: results.deleted, renamed: results.renamed, skipped: results.skipped, merged: results.merged, hooks: hooksToRun, dryRun });

    if (!dryRun) await writeManifest(rootDir, manifest);

    // Run hooks
    if (!dryRun) {
      for (const hook of hooksToRun) {
        // Hooks are shell commands from a possibly cloned manifest — always
        // announce them (stderr in --json mode so stdout stays parseable).
        if (!json) console.log(`\n  Running post-pull hook: ${hook}`);
        else console.error(`Running post-pull hook: ${hook}`);
        try {
          execSync(hook, { stdio: json ? ['ignore', 'ignore', 'inherit'] : 'inherit', cwd: rootDir });
        } catch {
          const message = `post-pull hook failed: ${hook}`;
          errors.push({ source: 'post-pull', error: message });
          if (!json) console.error(`  ERROR: ${message}`);
        }
      }
    }

    if (json) {
      console.log(JSON.stringify({
        added: results.added,
        updated: results.updated,
        deleted: results.deleted,
        renamed: results.renamed,
        skipped: results.skipped,
        merged: results.merged,
        hooksRun: hooksToRun,
        errors,
      }, null, 2));
    } else {
      if (results.added.length > 0) {
        console.log(`\n  Added:`);
        for (const p of results.added) console.log(`    ${statusCode('A')} ${p}`);
      }
      if (results.updated.length > 0) {
        console.log(`\n  Updated:`);
        for (const p of results.updated) console.log(`    ${statusCode('M')} ${p}`);
      }
      if (results.renamed.length > 0) {
        console.log(`\n  Renamed:`);
        for (const p of results.renamed) console.log(`    ${statusCode('R')} ${p}`);
      }
      if (results.deleted.length > 0) {
        console.log(`\n  Removed:`);
        for (const p of results.deleted) console.log(`    ${statusCode('D')} ${p}`);
      }
      if (results.skipped.length > 0) {
        console.log(`\n  Skipped (modified locally):`);
        for (const p of results.skipped) console.log(`    ${statusCode('!')} ${p}`);
      }
      if (results.merged.length > 0) {
        console.log(`\n  Merge markers added (resolve conflicts, then remove <<<<<<< trackcn blocks):`);
        for (const p of results.merged) console.log(`    ${statusCode('C')} ${p}`);
      }

      if (results.added.length === 0 && results.updated.length === 0 && results.deleted.length === 0 && results.renamed.length === 0 && results.skipped.length === 0 && results.merged.length === 0) {
        console.log(`\n  Everything up to date.`);
      }

      console.log('');
    }

    if (errors.length > 0) process.exit(1);
}

// ============================================================================
// CLI: status
// ============================================================================

interface StatusAction {
  code: 'A' | 'M' | 'D' | 'C';
  path: string;
  note?: string;
}

async function latestSourceFilesForStatus(rootDir: string, sourceEntry: RepocnSource, latestVersion?: string): Promise<SourceFile[] | null> {
  if (isRegistrySource(sourceEntry)) {
    const bundle = await resolveRegistryBundle(rootDir, sourceEntry.owner, sourceEntry.repo, sourceEntry.ref, sourceEntry.item);
    if (!bundle) throw new Error(`Registry item not found: ${sourceEntry.url}`);
    const files = bundle.files;
    if (sourceEntry.prefix) {
      for (const file of files) file.target = join(sourceEntry.prefix, file.target);
    }
    return files;
  }

  const parsed = parseUrl(sourceEntry.url);
  if (parsed.type === 'gist') {
    const gist = await fetchGist(parsed.gist);
    const files = gistToFiles(gist).filter((file) => file.type === 'regular');
    if (sourceEntry.prefix) {
      for (const file of files) file.target = join(sourceEntry.prefix, file.target);
    }
    return files;
  }
  if (parsed.type === 'raw') {
    const response = await fetch(parsed.url);
    if (!response.ok) throw new Error(`${response.status}`);
    const [target = parsed.filename] = Object.keys(sourceEntry.files);
    return filterIgnoredSourceFiles(sourceEntry, [{
      filename: parsed.filename,
      content: decodeFetchedContent(Buffer.from(await response.arrayBuffer())),
      type: 'regular',
      target,
    }]);
  }
  if (parsed.type === 'repo') {
    // Fetch at the resolved head (baseline SHA refs check the default branch)
    const rawFiles = await fetchRepoFiles(parsed.owner, parsed.repo, parsed.path, latestVersion || parsed.ref);
    if (parsed.startLine && rawFiles.length === 1 && typeof rawFiles[0].content === 'string') {
      const lines = rawFiles[0].content.split('\n');
      rawFiles[0].content = lines.slice(parsed.startLine - 1, parsed.endLine || parsed.startLine).join('\n') + '\n';
    }
    const files = repoFilesToSourceFiles(rawFiles, parsed.path).filter((file) => file.type === 'regular');
    const trackedKeys = Object.keys(sourceEntry.files);
    if (rawFiles.length === 1 && rawFiles[0].path === parsed.path && files.length === 1 && trackedKeys.length === 1) {
      // True single file: keep the tracked destination (supports file renames on add)
      files[0].target = trackedKeys[0];
    } else if (sourceEntry.prefix) {
      for (const file of files) file.target = withDestination(sourceEntry.prefix, file.target);
    }
    return filterIgnoredSourceFiles(sourceEntry, files);
  }

  return null;
}

async function statusActionsForChangedSource(rootDir: string, sourceEntry: RepocnSource, latestVersion?: string): Promise<StatusAction[] | null> {
  const latestFiles = await latestSourceFilesForStatus(rootDir, sourceEntry, latestVersion);
  if (!latestFiles) return null;

  const actions: StatusAction[] = [];
  const latestByTarget = new Map(latestFiles.map((file) => [file.target, file]));

  for (const [target, file] of latestByTarget) {
    const newHash = contentHash(file.content);
    const storedHash = sourceEntry.files[target];
    const fullPath = targetPath(rootDir, target);

    if (!storedHash) {
      actions.push({ code: 'A', path: target });
      continue;
    }
    if (newHash === storedHash) continue;

    if (!existsSync(fullPath)) {
      actions.push({ code: 'A', path: target, note: 'missing locally' });
      continue;
    }

    const diskHash = contentHash(await readFile(fullPath));
    actions.push(diskHash === storedHash
      ? { code: 'M', path: target }
      : { code: 'C', path: target, note: 'modified locally' });
  }

  for (const target of trackedFilePaths(sourceEntry)) {
    if (!latestByTarget.has(target)) actions.push({ code: 'D', path: target });
  }

  return actions.sort((a, b) => a.path.localeCompare(b.path));
}

async function cmdStatus() {
    const rootDir = process.cwd();
    const manifest = await readManifest(rootDir);

    if (!manifest || manifest.sources.length === 0) {
      console.error('No trackcn.json found. Run `trackcn add <url>` first.');
      process.exit(1);
    }

    let stale = false;
    let drifted = false;
    let failed = false;
    let conflicted = false;

    if (!json) console.log(`\nChecking ${manifest.sources.length} source${manifest.sources.length === 1 ? '' : 's'}...\n`);

    const jsonSources: Array<Record<string, unknown>> = [];
    const repoCommitCache = new Map<string, Promise<string>>();
    const getRepoCommitSha = (owner: string, repo: string, ref: string): Promise<string> => {
      const key = `${owner}/${repo}@${ref}`;
      let request = repoCommitCache.get(key);
      if (!request) {
        request = fetchRepoCommitSha(owner, repo, ref);
        repoCommitCache.set(key, request);
      }
      return request;
    };
    const repoHeadCache = new Map<string, Promise<string>>();
    const getRepoHeadSha = (owner: string, repo: string, ref: string): Promise<string> => {
      const key = `${owner}/${repo}@${ref}`;
      let request = repoHeadCache.get(key);
      if (!request) {
        request = resolveRepoHeadSha(owner, repo, ref);
        repoHeadCache.set(key, request);
      }
      return request;
    };

    for (const sourceEntry of manifest.sources) {
      let latestVersion: string;

      try {
        if (isRegistrySource(sourceEntry)) {
          latestVersion = await getRepoCommitSha(sourceEntry.owner, sourceEntry.repo, sourceEntry.ref);
        } else {
        const parsed = parseUrl(sourceEntry.url);
        if (parsed.type === 'gist') {
          const gist = await fetchGist(parsed.gist);
          latestVersion = gist.history?.[0]?.version || '';
        } else if (parsed.type === 'raw') {
          const response = await fetch(parsed.url);
          if (!response.ok) throw new Error(`${response.status}`);
          latestVersion = contentHash(Buffer.from(await response.arrayBuffer()));
        } else if (parsed.type === 'commit') {
          // Immutable — version never changes
          latestVersion = sourceEntry.version;
        } else if (parsed.type === 'commit-range') {
          try {
            latestVersion = await getRepoCommitSha(parsed.owner, parsed.repo, parsed.head);
          } catch {
            latestVersion = parsed.head;
          }
        } else if (parsed.type === 'pull') {
          const pr = await fetchPullRequest(parsed.owner, parsed.repo, parsed.number);
          latestVersion = pr.head.sha;
        } else {
          if (parsed.type !== 'repo') throw new Error(`Unsupported source: ${sourceEntry.url}`);
          latestVersion = await getRepoHeadSha(parsed.owner, parsed.repo, parsed.ref);
        }
        }
      } catch (error) {
        failed = true;
        if (!json) {
          console.log(`  ${sourceLabel(sourceEntry.url, sourceEntry.version)}`);
          console.log(`    ERROR: ${(error as Error).message}`);
        }
        jsonSources.push({ url: sourceEntry.url, error: (error as Error).message });
        continue;
      }

      const versionChanged = latestVersion !== sourceEntry.version;

      const localDrift: string[] = [];
      const missing: string[] = [];
      const unresolvedMerges: string[] = [];
      let upstreamActions: StatusAction[] | null = [];
      for (const [filePath, storedHash] of trackedFileEntries(sourceEntry)) {
        const fullPath = targetPath(rootDir, filePath);
        if (!existsSync(fullPath)) { missing.push(filePath); continue; }
        const diskContent = await readFile(fullPath);
        const diskText = asText(diskContent);
        if (diskText !== null && hasMergeMarker(diskText)) unresolvedMerges.push(filePath);
        const diskHash = contentHash(diskContent);
        if (diskHash !== storedHash) localDrift.push(filePath);
      }

      if (localDrift.length > 0 || missing.length > 0 || unresolvedMerges.length > 0) drifted = true;
      if (unresolvedMerges.length > 0) conflicted = true;
      let sourceStale = false;
      if (versionChanged) {
        // If the detailed diff can't be computed, null still marks the source
        // stale — the version comparison already proved upstream moved.
        upstreamActions = await statusActionsForChangedSource(rootDir, sourceEntry, latestVersion).catch(() => null);
        sourceStale = upstreamActions === null || upstreamActions.length > 0;
        if (sourceStale) stale = true;
        if (upstreamActions?.some((action) => action.code === 'C')) conflicted = true;
      }
      const hasHumanAction = sourceStale || unresolvedMerges.length > 0;

      if (json) {
        jsonSources.push({
          url: sourceEntry.url,
          upToDate: !versionChanged && localDrift.length === 0 && missing.length === 0 && unresolvedMerges.length === 0,
          currentVersion: sourceEntry.version,
          latestVersion,
          versionChanged,
          files: trackedFilePaths(sourceEntry).length,
          locallyModified: localDrift,
          missing,
          unresolvedMerges,
          upstreamActions: upstreamActions || [],
        });
      } else if (hasHumanAction) {
        console.log(`  ${sourceLabel(sourceEntry.url, sourceEntry.version)}`);
        if (versionChanged && sourceStale) {
          console.log(`    Upstream changed (${sourceEntry.version.slice(0, 8)} -> ${latestVersion.slice(0, 8)})`);
          for (const action of upstreamActions || []) {
            console.log(`    ${statusCode(action.code)} ${action.path}${action.note ? ` (${action.note})` : ''}`);
          }
        }
        for (const p of unresolvedMerges) console.log(`    ${statusCode('C')} ${p} (unresolved merge)`);
      }
    }

    if (json) {
      console.log(JSON.stringify({ sources: jsonSources, stale, drifted, failed }, null, 2));
    } else {
      if (!stale && !failed && !conflicted) console.log('  No upstream changes.\n');
      else {
        console.log('');
        if (stale) console.log('  Run `trackcn pull` to update.\n');
      }
    }

    await trace('status:done', { stale, drifted, sources: jsonSources.map((s: Record<string, unknown>) => ({ url: s.url, versionChanged: s.versionChanged, locallyModified: s.locallyModified, unresolvedMerges: s.unresolvedMerges })) });

    if (json ? (stale || drifted || failed) : (stale || conflicted || failed)) process.exit(1);
}

// ============================================================================
// CLI: remove
// ============================================================================

async function cmdRemove(positional: string[]) {
  if (positional.length === 0) {
    console.error('Usage: trackcn remove <url>');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const loadedManifest = await readManifest(rootDir);

  if (!loadedManifest || loadedManifest.sources.length === 0) {
    console.error('No trackcn.json found. Nothing to remove.');
    process.exit(1);
  }
  const manifest = loadedManifest;

  const hard = args['--hard'] || false;
  const input = positional[0];

  async function removeSourceAt(index: number, partial: boolean): Promise<void> {
    const source = manifest.sources[index];
    const filePaths = Object.keys(source.files);
    const removed = hard ? filePaths : [];
    manifest.sources.splice(index, 1);
    if (hard) {
      for (const filePath of removed) {
        const fullPath = targetPath(rootDir, filePath);
        if (existsSync(fullPath)) await unlink(fullPath);
      }
    }
    await writeManifest(rootDir, manifest);
    if (json) {
      console.log(JSON.stringify({ url: source.url, files: removed, hard }, null, 2));
    } else {
      console.log(`\nRemoving ${source.url}`);
      if (hard) {
        for (const filePath of removed) console.log(`  - ${filePath}`);
      } else {
        console.log(`  ${filePaths.length} file${filePaths.length === 1 ? '' : 's'} left on disk (use --hard to delete)`);
      }
      console.log('');
    }
    await trace('remove:done', { url: source.url, hard, partial });
  }

  async function ignoreSubpath(sourceIndex: number, pattern: string): Promise<void> {
    const source = manifest.sources[sourceIndex];
    const ignored = trackedFilePaths(source).filter((filePath) => pathMatchesPattern(filePath, pattern));
    if (ignored.length === 0) {
      console.error(`Tracked path not found: ${pattern}`);
      console.error(`\nTracked sources:`);
      for (const s of manifest.sources) console.error(`  ${s.url}`);
      process.exit(1);
    }

    source.ignore = unique([...(source.ignore || []), pattern]);
    for (const filePath of ignored) {
      delete source.files[filePath];
      if (hard) {
        const fullPath = targetPath(rootDir, filePath);
        if (existsSync(fullPath)) await unlink(fullPath);
      }
    }

    await writeManifest(rootDir, manifest);
    if (json) {
      console.log(JSON.stringify({ url: source.url, ignored: pattern, files: ignored, hard }, null, 2));
    } else {
      console.log(`\nIgnoring ${pattern}`);
      console.log(`  ${source.url}`);
      for (const filePath of ignored) console.log(`  ${hard ? '-' : '·'} ${filePath}`);
      if (!hard) console.log(`  ${ignored.length} file${ignored.length === 1 ? '' : 's'} left on disk`);
      console.log('');
    }
    await trace('remove:ignore', { url: source.url, pattern, files: ignored, hard });
  }

  let sourceUrl: string | null = null;
  try {
    sourceUrl = canonicalUrl(parseUrl(input));
  } catch {
    sourceUrl = null;
  }

  if (sourceUrl) {
    const idx = manifest.sources.findIndex((s) => s.url === sourceUrl);
    if (idx !== -1) {
      await removeSourceAt(idx, false);
      return;
    }
  }

  let pattern: string;
  try {
    pattern = normalizeManifestPath(input);
  } catch {
    pattern = '';
  }

  if (pattern) {
    const sourceIndex = manifest.sources.findIndex((source) =>
      trackedFilePaths(source).some((filePath) => pathMatchesPattern(filePath, pattern))
    );
    if (sourceIndex !== -1) {
      await ignoreSubpath(sourceIndex, pattern);
      return;
    }
  }

  const partial = manifest.sources.findIndex((s) => s.url.includes(input));
  if (partial !== -1) {
    await removeSourceAt(partial, true);
    return;
  }

  console.error(`Source or tracked path not found: ${input}`);
  console.error(`\nTracked sources:`);
  for (const s of manifest.sources) console.error(`  ${s.url}`);
  process.exit(1);
}

// ============================================================================
// CLI: dispatch
// ============================================================================

trace('cli:start', { command, positional, flags: { json, force: args['--force'], hard: args['--hard'], dryRun: args['--dry-run'], postPull: args['--post-pull'] } });

switch (command) {
  case 'add':
    cmdAdd(positional);
    break;
  case 'pull':
    cmdPull();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'remove':
  case 'rm':
    cmdRemove(positional);
    break;
  case 'auth':
    cmdAuth(positional);
    break;
  case 'skills':
    cmdSkills(positional);
    break;
  default:
    showHelp();
    process.exit(command ? 1 : 0);
}
