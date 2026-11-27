import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findGitLocation } from './gitHubUrlResolver';

export type DiffMode =
  | 'HEAD_SINGLE_FILE'
  | 'HEAD_DIRECTORY'
  | 'TWO_FILES'
  | 'HEAD_MULTI_FILES';

export interface DiffPlan {
  readonly mode: DiffMode;
  readonly label: string;
  readonly arguments: readonly string[];
}

export interface LaunchResult {
  readonly started: boolean;
  readonly url: string | null;
  readonly errorMessage: string | null;
}

export interface ExecutableResolutionOptions {
  readonly configPath?: string;
  readonly envOverride?: string;
  readonly pathEnv?: string;
  readonly userHome?: string | null;
  readonly workspaceDirs?: readonly string[];
}

const RUNNING_PREFIX = 'local-diff-san running at ';
const RUNNING_URL_PATTERN = /local-diff-san running at (https?:\/\/\S+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 4000;

/**
 * Builds the `local-diff-san` invocation plan for the selected filesystem paths,
 * or returns `null` if the selection cannot be diffed against `HEAD` or as a two-file pair.
 */
export function planSelection(rawPaths: readonly string[]): DiffPlan | null {
  const paths = normalizeUniqueExistingPaths(rawPaths);
  if (!paths || paths.length === 0) {
    return null;
  }

  if (paths.length === 1) {
    return planSinglePath(paths[0]);
  }

  if (paths.length === 2) {
    if (isFileSafe(paths[0]) && isFileSafe(paths[1])) {
      return {
        mode: 'TWO_FILES',
        label: 'Diff Two Files (diff_san)',
        arguments: [paths[0], paths[1]],
      };
    }
    return null;
  }

  for (const p of paths) {
    if (!isFileSafe(p) || !findGitLocation(p)) {
      return null;
    }
  }
  return {
    mode: 'HEAD_MULTI_FILES',
    label: 'Diff Files against HEAD (diff_san)',
    arguments: ['--head', ...paths],
  };
}

/**
 * Resolves the `local-diff-san` binary from settings, `DIFF_SAN_BIN`, `PATH`,
 * workspace virtualenvs, or standard user install directories.
 */
export function resolveExecutable(options: ExecutableResolutionOptions = {}): string | null {
  const userHome =
    options.userHome !== undefined ? options.userHome : os.homedir() || null;
  const configPath = options.configPath;
  const envOverride =
    options.envOverride !== undefined ? options.envOverride : process.env.DIFF_SAN_BIN;
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH;

  for (const explicit of [configPath, envOverride]) {
    if (explicit && explicit.trim()) {
      const resolved = expandUserHome(explicit.trim(), userHome);
      if (isDirectorySafe(resolved)) {
        const inside = findInDirectory(resolved);
        if (inside) {
          return inside;
        }
      } else if (isExecutableFile(resolved)) {
        return resolved;
      }
    }
  }

  if (pathEnv && pathEnv.trim()) {
    for (const entry of pathEnv.split(path.delimiter)) {
      if (entry.trim()) {
        const found = findInDirectory(expandUserHome(entry.trim(), userHome));
        if (found) {
          return found;
        }
      }
    }
  }

  for (const dir of candidateBinDirectories(userHome, options.workspaceDirs ?? [])) {
    const found = findInDirectory(dir);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Extracts the localhost server URL emitted by `local-diff-san` once ready.
 */
export function extractRunningUrl(output: string | null | undefined): string | null {
  if (!output || !output.includes(RUNNING_PREFIX)) {
    return null;
  }
  const match = RUNNING_URL_PATTERN.exec(output);
  return match ? match[1] : null;
}

/**
 * Spawns `local-diff-san` detached from the extension host and checks for early startup errors.
 */
export async function launchDiffSan(
  executable: string | null,
  plan: DiffPlan,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<LaunchResult> {
  if (!executable) {
    return {
      started: false,
      url: null,
      errorMessage:
        "Could not find 'local-diff-san'. Install diff_san (e.g. ~/gitland/python_venv/bin/local-diff-san), set DIFF_SAN_BIN, or configure githubSan.diffSanExecutable.",
    };
  }

  let logDir: string;
  let logFile: string;
  let outFd: number;
  try {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-san-'));
    logFile = path.join(logDir, 'server.log');
    outFd = fs.openSync(logFile, 'w');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      started: false,
      url: null,
      errorMessage: `Failed to prepare local-diff-san log file: ${msg}`,
    };
  }

  const env = buildEnvWithBinDir(executable);
  let childExitedCode: number | null = null;
  let spawnError: Error | null = null;

  const child = spawn(executable, [...plan.arguments], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env,
  });

  // Child inherits the opened fd; close parent's copy immediately.
  try {
    fs.closeSync(outFd);
  } catch {
    // Ignore close failure.
  }

  child.on('error', (err) => {
    spawnError = err;
  });
  child.on('exit', (code) => {
    childExitedCode = code ?? 1;
  });

  const timeoutMs = Math.max(200, startupTimeoutMs);
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      if (spawnError) {
        return {
          started: false,
          url: null,
          errorMessage: `Failed to start local-diff-san: ${(spawnError as Error).message}`,
        };
      }

      const output = readLogSafely(logFile);
      const runningUrl = extractRunningUrl(output);
      if (runningUrl) {
        child.unref();
        return { started: true, url: runningUrl, errorMessage: null };
      }

      if (childExitedCode !== null) {
        if (childExitedCode === 0) {
          return { started: true, url: null, errorMessage: null };
        }
        return {
          started: false,
          url: null,
          errorMessage: formatFailure(childExitedCode, output),
        };
      }

      if (Date.now() >= deadline) {
        child.unref();
        return { started: true, url: null, errorMessage: null };
      }

      await delay(50);
    }
  } finally {
    child.removeAllListeners('error');
    child.removeAllListeners('exit');
  }
}

function planSinglePath(target: string): DiffPlan | null {
  if (!findGitLocation(target)) {
    return null;
  }
  if (isDirectorySafe(target)) {
    return {
      mode: 'HEAD_DIRECTORY',
      label: 'Diff Directory against HEAD (diff_san)',
      arguments: [target],
    };
  }
  if (isFileSafe(target)) {
    return {
      mode: 'HEAD_SINGLE_FILE',
      label: 'Diff against HEAD (diff_san)',
      arguments: [target],
    };
  }
  return null;
}

function normalizeUniqueExistingPaths(rawPaths: readonly string[]): string[] | null {
  if (!rawPaths || rawPaths.length === 0) {
    return null;
  }
  const unique = new Set<string>();
  for (const raw of rawPaths) {
    if (!raw) {
      return null;
    }
    const normalized = path.resolve(raw);
    if (!fs.existsSync(normalized)) {
      return null;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function candidateBinDirectories(
  userHome: string | null,
  workspaceDirs: readonly string[],
): string[] {
  const dirs: string[] = [];
  const subdirs = process.platform === 'win32' ? ['Scripts', 'bin'] : ['bin'];

  for (const ws of workspaceDirs) {
    if (!ws) {
      continue;
    }
    for (const sub of subdirs) {
      dirs.push(path.join(ws, '.venv', sub));
      dirs.push(path.join(ws, 'venv', sub));
    }
  }

  if (userHome) {
    for (const sub of subdirs) {
      dirs.push(path.join(userHome, 'gitland', 'python_venv', sub));
    }
    dirs.push(path.join(userHome, '.local', 'bin'));
    for (const sub of subdirs) {
      dirs.push(path.join(userHome, '.venv', sub));
      dirs.push(path.join(userHome, 'venv', sub));
      dirs.push(path.join(userHome, 'gitland', 'sanskrit-coders', 'diff_san', '.venv', sub));
    }
  }
  return dirs;
}

function findInDirectory(directory: string): string | null {
  if (!directory || !isDirectorySafe(directory)) {
    return null;
  }
  for (const name of candidateBinaryNames()) {
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function candidateBinaryNames(): readonly string[] {
  if (process.platform === 'win32') {
    return ['local-diff-san.exe', 'local-diff-san.cmd', 'local_diff_san.exe', 'local-diff-san', 'local_diff_san'];
  }
  return ['local-diff-san', 'local_diff_san'];
}

function isExecutableFile(candidate: string): boolean {
  if (!isFileSafe(candidate)) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandUserHome(value: string, userHome: string | null): string {
  if (userHome && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) {
    const remainder = value.length <= 2 ? '' : value.slice(2);
    return remainder ? path.join(userHome, remainder) : userHome;
  }
  return path.resolve(value);
}

function buildEnvWithBinDir(executable: string): NodeJS.ProcessEnv {
  const binDir = path.dirname(path.resolve(executable));
  const env: NodeJS.ProcessEnv = { ...process.env };
  const currentPath = env.PATH || '';
  if (!currentPath) {
    env.PATH = binDir;
  } else if (!currentPath.split(path.delimiter).includes(binDir)) {
    env.PATH = `${binDir}${path.delimiter}${currentPath}`;
  }
  return env;
}

function readLogSafely(logFile: string): string {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

function formatFailure(exitCode: number, output: string): string {
  const trimmed = output.trim();
  return trimmed
    ? `local-diff-san exited with code ${exitCode}: ${trimmed}`
    : `local-diff-san exited with code ${exitCode}`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
