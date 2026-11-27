import { execFile, ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitLocation {
  readonly repoRoot: string;
  readonly gitDir: string;
}

export interface LineRange {
  readonly oneBasedStart: number;
  readonly oneBasedEnd: number;
}

interface RemoteInfo {
  readonly name: string;
  readonly githubBaseUrl: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const REMOTE_SECTION_PATTERN = /^\[remote\s+"([^"]+)"\s*]$/;
const SCP_REMOTE_PATTERN = /^(?:[^@]+@)?([^:/]+):(.+)$/;
const GIT_TIMEOUT_MS = 10_000;

/**
 * Walks up from `target` to find the enclosing Git working tree root and resolved `.git` directory,
 * supporting normal repositories, Git submodules, and Git worktrees.
 */
export function findGitLocation(target: string): GitLocation | null {
  if (!target) {
    return null;
  }
  const normalized = path.resolve(target);
  let current = isDirectorySafe(normalized) ? normalized : path.dirname(normalized);

  while (true) {
    const dotGit = path.join(current, '.git');
    if (isDirectorySafe(dotGit)) {
      return { repoRoot: current, gitDir: dotGit };
    }
    if (isFileSafe(dotGit)) {
      const resolvedGitDir = resolveGitDirFile(current, dotGit);
      if (resolvedGitDir && isDirectorySafe(resolvedGitDir)) {
        return { repoRoot: current, gitDir: resolvedGitDir };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Parses common Git remote URL forms into `https://github.com/<owner>/<repo>`,
 * or returns `null` when the remote is not a GitHub repository URL.
 */
export function parseGithubBaseUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let host = '';
  let pathPart = '';
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      pathPart = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const match = SCP_REMOTE_PATTERN.exec(trimmed);
    if (!match) {
      return null;
    }
    host = match[1];
    pathPart = match[2];
  }

  if (host.toLowerCase() !== 'github.com' || !pathPart) {
    return null;
  }

  let cleaned = trimSlashes(pathPart);
  if (cleaned.endsWith('.git')) {
    cleaned = cleaned.slice(0, -4);
  }
  cleaned = trimSlashes(cleaned);

  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

/**
 * Resolves `target` to its canonical GitHub web URL using Git metadata in the enclosing repo/submodule.
 */
export async function resolveGithubUrl(
  target: string,
  lineRange: LineRange | null = null,
): Promise<string> {
  const normalized = path.resolve(target);
  const location = findGitLocation(normalized);
  if (!location) {
    throw new Error(`Not inside a Git repository: ${normalized}`);
  }

  const { repoRoot, gitDir } = location;
  const remoteUrls = await readRemotesViaGit(repoRoot, gitDir);
  const remote = await selectGithubRemote(repoRoot, remoteUrls);
  if (!remote) {
    throw new Error(`No GitHub remote found for repository: ${repoRoot}`);
  }

  const ref = await resolveRemoteRef(repoRoot, remote.name);
  const relativePath = toUnixRelativePath(path.relative(repoRoot, normalized));
  const isDirectory = isDirectorySafe(normalized);

  if (!relativePath) {
    return `${remote.githubBaseUrl}/tree/${encodePathSegments(ref)}`;
  }

  const kind = isDirectory ? 'tree' : 'blob';
  let url = `${remote.githubBaseUrl}/${kind}/${encodePathSegments(ref)}/${encodePathSegments(relativePath)}`;

  if (!isDirectory && lineRange && lineRange.oneBasedStart >= 1) {
    url += `#L${lineRange.oneBasedStart}`;
    if (lineRange.oneBasedEnd > lineRange.oneBasedStart) {
      url += `-L${lineRange.oneBasedEnd}`;
    }
  }
  return url;
}

/**
 * Reads `[remote "<name>"]` URL entries from `<gitDir>/config` or worktree `commondir`.
 */
export function readRemoteUrlsFromConfig(gitDir: string): Map<string, string> {
  const remotes = new Map<string, string>();
  const configPath = resolveConfigPath(gitDir);
  if (!configPath || !isFileSafe(configPath)) {
    return remotes;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    let currentRemote: string | null = null;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) {
        continue;
      }
      if (line.startsWith('[')) {
        const match = REMOTE_SECTION_PATTERN.exec(line);
        currentRemote = match ? match[1] : null;
        continue;
      }
      if (currentRemote !== null) {
        const eq = line.indexOf('=');
        if (eq > 0) {
          const key = line.slice(0, eq).trim().toLowerCase();
          if (key === 'url' && !remotes.has(currentRemote)) {
            remotes.set(currentRemote, line.slice(eq + 1).trim());
          }
        }
      }
    }
  } catch {
    // Return any remotes collected before error.
  }
  return remotes;
}

/**
 * URL-encodes each path segment individually while keeping `/` separators unescaped.
 */
export function encodePathSegments(relPath: string): string {
  if (!relPath) {
    return '';
  }
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function resolveGitDirFile(repoRoot: string, dotGitFile: string): string | null {
  try {
    const content = fs.readFileSync(dotGitFile, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.toLowerCase().startsWith('gitdir:')) {
        const target = line.slice('gitdir:'.length).trim();
        if (target) {
          return path.resolve(repoRoot, target);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveConfigPath(gitDir: string): string | null {
  const directConfig = path.join(gitDir, 'config');
  if (isFileSafe(directConfig)) {
    return directConfig;
  }
  const commonDirFile = path.join(gitDir, 'commondir');
  if (isFileSafe(commonDirFile)) {
    try {
      const rel = fs.readFileSync(commonDirFile, 'utf8').trim();
      if (rel) {
        const commonConfig = path.join(path.resolve(gitDir, rel), 'config');
        if (isFileSafe(commonConfig)) {
          return commonConfig;
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function readRemotesViaGit(repoRoot: string, gitDir: string): Promise<Map<string, string>> {
  const result = await runGit(repoRoot, 'remote', '-v');
  const remotes = new Map<string, string>();
  if (result.exitCode === 0) {
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const tokens = trimmed.split(/\s+/);
      if (tokens.length >= 2 && !remotes.has(tokens[0])) {
        remotes.set(tokens[0], tokens[1]);
      }
    }
  }
  if (remotes.size === 0) {
    for (const [name, url] of readRemoteUrlsFromConfig(gitDir)) {
      remotes.set(name, url);
    }
  }
  return remotes;
}

async function selectGithubRemote(
  repoRoot: string,
  remoteUrls: Map<string, string>,
): Promise<RemoteInfo | null> {
  const currentBranch = await getCurrentBranch(repoRoot);
  if (currentBranch) {
    const trackedRemoteRes = await runGit(
      repoRoot,
      'config',
      '--get',
      `branch.${currentBranch}.remote`,
    );
    if (trackedRemoteRes.exitCode === 0) {
      const trackedName = trackedRemoteRes.stdout.trim();
      const trackedBase = parseGithubBaseUrl(remoteUrls.get(trackedName));
      if (trackedBase) {
        return { name: trackedName, githubBaseUrl: trackedBase };
      }
    }
  }

  const originBase = parseGithubBaseUrl(remoteUrls.get('origin'));
  if (originBase) {
    return { name: 'origin', githubBaseUrl: originBase };
  }

  for (const [name, url] of remoteUrls.entries()) {
    const base = parseGithubBaseUrl(url);
    if (base) {
      return { name, githubBaseUrl: base };
    }
  }
  return null;
}

async function resolveRemoteRef(repoRoot: string, remoteName: string): Promise<string> {
  const upstreamRes = await runGit(
    repoRoot,
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  );
  if (upstreamRes.exitCode === 0) {
    const upstream = upstreamRes.stdout.trim();
    const prefix = `${remoteName}/`;
    if (upstream.startsWith(prefix) && upstream.length > prefix.length) {
      return upstream.slice(prefix.length);
    }
  }

  const branch = await getCurrentBranch(repoRoot);
  if (branch) {
    const remoteBranchRes = await runGit(
      repoRoot,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/remotes/${remoteName}/${branch}`,
    );
    if (remoteBranchRes.exitCode === 0) {
      return branch;
    }
  }

  const headShaRes = await runGit(repoRoot, 'rev-parse', 'HEAD');
  if (headShaRes.exitCode === 0 && headShaRes.stdout.trim()) {
    return headShaRes.stdout.trim();
  }
  throw new Error(`Cannot resolve branch or commit for repository: ${repoRoot}`);
}

async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  const res = await runGit(repoRoot, 'symbolic-ref', '-q', '--short', 'HEAD');
  if (res.exitCode === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return null;
}

function runGit(repoRoot: string, ...args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { timeout: GIT_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        const execErr = err as ExecFileException;
        if (typeof execErr.code === 'number') {
          resolve({ exitCode: execErr.code, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        if (execErr.killed) {
          reject(new Error(`Timed out running git -C ${repoRoot} ${args.join(' ')}`));
          return;
        }
        reject(err);
      },
    );
  });
}

function isDirectorySafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function toUnixRelativePath(rel: string): string {
  const unix = rel.split(path.sep).join('/');
  return unix === '.' ? '' : unix;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}
