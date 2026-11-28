import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandResult,
  findGitLocation,
  runGitWithOptions,
} from './gitHubUrlResolver';

const GIT_QUERY_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 180_000;
const HOOK_BEGIN_MARKER = '# >>> github-san submodule auto-push >>>';
const HOOK_END_MARKER = '# <<< github-san submodule auto-push <<<';

export type PushMode = 'autoWhenNotConfigured' | 'always';

export interface SubmoduleEntry {
  readonly relativePath: string;
  readonly root: string;
  readonly configuredBranch?: string;
}

export interface PushResult {
  readonly pushedSubmodules: readonly string[];
  readonly skippedDetachedSubmodules: readonly string[];
  readonly failedSubmodules: Readonly<Record<string, string>>;
  readonly skippedBecauseConfigured: boolean;
}

export interface HookInstallResult {
  readonly hookFile: string;
  readonly updated: boolean;
  readonly customHooksPathWarning?: string;
}

export interface PushSubmodulesOptions {
  readonly excludedRoots?: ReadonlySet<string>;
  readonly mode?: PushMode;
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

type UpstreamState =
  | 'UP_TO_DATE'
  | 'DETACHED'
  | 'NO_REMOTE'
  | 'UNTRACKED_BRANCH'
  | 'NEEDS_PUSH_EXISTING_UPSTREAM'
  | 'NEEDS_PUSH_SET_UPSTREAM';

interface PushPlan {
  readonly state: UpstreamState;
  readonly remoteName?: string;
  readonly branchName?: string;
}

/**
 * Discovers initialized submodules under `repoRoot` in bottom-up (post-order) dependency order.
 */
export async function discoverSubmodulesBottomUp(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<SubmoduleEntry[]> {
  if (!repoRoot || !isDirectorySafe(repoRoot)) {
    return [];
  }
  const normalizedRoot = path.resolve(repoRoot);
  const visitedRoots = new Set<string>([toRealOrNormalized(normalizedRoot)]);
  const entries: SubmoduleEntry[] = [];
  await collectSubmodulesRecursive(normalizedRoot, normalizedRoot, visitedRoots, entries, env);
  return entries;
}

/**
 * Reads the effective `push.recurseSubmodules` setting visible inside `repoRoot`,
 * or returns `null` when unset.
 */
export async function getEffectivePushRecurseSubmodules(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!repoRoot || !isDirectorySafe(repoRoot)) {
    return null;
  }
  const res = await runGitQuery(repoRoot, ['config', '--get', 'push.recurseSubmodules'], env);
  if (res.exitCode !== 0) {
    return null;
  }
  const trimmed = res.stdout.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Returns true when `push.recurseSubmodules` already pushes submodules (`on-demand`, `only`, or `check`).
 */
export function isRecurseSubmodulesEnabled(configValue: string | null | undefined): boolean {
  if (!configValue) {
    return false;
  }
  const normalized = configValue.trim().toLowerCase();
  return normalized === 'on-demand' || normalized === 'only' || normalized === 'check';
}

/**
 * Configures `git config --global push.recurseSubmodules on-demand`.
 */
export async function enableGlobalRecurseSubmodules(
  workingDir?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const effectiveDir = workingDir && isDirectorySafe(workingDir) ? workingDir : os.homedir();
  const res = await runGitQuery(
    effectiveDir,
    ['config', '--global', 'push.recurseSubmodules', 'on-demand'],
    env,
  );
  if (res.exitCode !== 0) {
    throw new Error(extractError(res, 'git config --global push.recurseSubmodules on-demand failed'));
  }
}

/**
 * Installs or updates the idempotent bottom-up `pre-push` hook in `repoRoot`.
 */
export async function installPrePushHook(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<HookInstallResult> {
  if (!repoRoot || !isDirectorySafe(repoRoot)) {
    throw new Error(`Repository directory does not exist: ${repoRoot}`);
  }
  const customHooksPathWarning = await checkCustomHooksPath(repoRoot, env);
  const hooksDir = await resolveDefaultHooksDir(repoRoot, env);
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookFile = path.join(hooksDir, 'pre-push');

  const existing = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '';
  const updatedContent = upsertManagedHookBlock(existing, buildHookSnippet());
  const updated = updatedContent !== existing;
  if (updated) {
    fs.writeFileSync(hookFile, updatedContent, 'utf8');
  }
  try {
    fs.chmodSync(hookFile, 0o755);
  } catch {
    // Best-effort permission update on non-POSIX filesystems.
  }
  return { hookFile, updated, customHooksPathWarning };
}

/**
 * Pushes initialized submodules with unpushed commits bottom-up.
 * In `'autoWhenNotConfigured'` mode, skips when `push.recurseSubmodules` is already enabled.
 */
export async function pushPendingSubmodules(
  repoRoot: string,
  options: PushSubmodulesOptions = {},
): Promise<PushResult> {
  if (!repoRoot || !isDirectorySafe(repoRoot)) {
    return emptyResult(false);
  }
  const mode = options.mode ?? 'autoWhenNotConfigured';
  if (mode === 'autoWhenNotConfigured') {
    const configured = await getEffectivePushRecurseSubmodules(repoRoot, options.env);
    if (isRecurseSubmodulesEnabled(configured)) {
      return emptyResult(true);
    }
  }

  const excluded = normalizeExcludedRoots(options.excludedRoots);
  const submodules = await discoverSubmodulesBottomUp(repoRoot, options.env);
  const pushedSubmodules: string[] = [];
  const skippedDetachedSubmodules: string[] = [];
  const failedSubmodules: Record<string, string> = {};

  for (const submodule of submodules) {
    if (options.isCancelled?.()) {
      throw new Error('Submodule push cancelled.');
    }
    if (excluded.has(toRealOrNormalized(submodule.root))) {
      continue;
    }

    const plan = await computePushPlan(submodule, options.env);
    if (plan.state === 'DETACHED') {
      skippedDetachedSubmodules.push(submodule.relativePath);
      continue;
    }
    if (plan.state !== 'NEEDS_PUSH_EXISTING_UPSTREAM' && plan.state !== 'NEEDS_PUSH_SET_UPSTREAM') {
      continue;
    }

    options.onProgress?.(`Pushing submodule ${submodule.relativePath}...`);
    const pushRes = await executeSubmodulePush(submodule.root, plan, options.env);
    if (pushRes.exitCode === 0) {
      pushedSubmodules.push(submodule.relativePath);
    } else {
      failedSubmodules[submodule.relativePath] = extractError(pushRes, 'git push failed');
      break;
    }
  }

  return {
    pushedSubmodules,
    skippedDetachedSubmodules,
    failedSubmodules,
    skippedBecauseConfigured: false,
  };
}

/**
 * Pushes ahead submodules bottom-up and then pushes `repoRoot` itself.
 */
export async function pushSubmodulesAndRepo(
  repoRoot: string,
  options: Omit<PushSubmodulesOptions, 'mode' | 'excludedRoots'> = {},
): Promise<PushResult> {
  const subResult = await pushPendingSubmodules(repoRoot, {
    ...options,
    mode: 'always',
  });
  if (hasFailures(subResult)) {
    return subResult;
  }
  if (options.isCancelled?.()) {
    throw new Error('Repository push cancelled.');
  }
  options.onProgress?.(`Pushing repository ${path.basename(repoRoot)}...`);
  const parentPush = await runGitPush(repoRoot, ['push'], options.env);
  if (parentPush.exitCode !== 0) {
    return {
      pushedSubmodules: subResult.pushedSubmodules,
      skippedDetachedSubmodules: subResult.skippedDetachedSubmodules,
      failedSubmodules: {
        ...subResult.failedSubmodules,
        '.': extractError(parentPush, 'git push failed'),
      },
      skippedBecauseConfigured: false,
    };
  }
  return subResult;
}

/**
 * Resolves the repository root to operate on, preferring an enclosing workspace superproject
 * that declares `.gitmodules` over a file inside one of its child submodules unless that submodule
 * itself declares nested `.gitmodules`.
 */
export function resolveTargetRepoRoot(
  candidatePaths: readonly string[],
  workspaceDirs: readonly string[],
): string | null {
  let selectedRoot: string | null = null;
  for (const candidate of candidatePaths) {
    const loc = findGitLocation(candidate);
    if (loc) {
      selectedRoot = loc.repoRoot;
      break;
    }
  }

  let workspaceSuperRoot: string | null = null;
  for (const dir of workspaceDirs) {
    const loc = findGitLocation(dir);
    if (!loc) {
      continue;
    }
    if (!workspaceSuperRoot) {
      workspaceSuperRoot = loc.repoRoot;
    }
    if (fs.existsSync(path.join(loc.repoRoot, '.gitmodules'))) {
      workspaceSuperRoot = loc.repoRoot;
      break;
    }
  }

  if (
    workspaceSuperRoot &&
    fs.existsSync(path.join(workspaceSuperRoot, '.gitmodules')) &&
    (!selectedRoot || !fs.existsSync(path.join(selectedRoot, '.gitmodules')))
  ) {
    return workspaceSuperRoot;
  }
  return selectedRoot ?? workspaceSuperRoot;
}

export function hasFailures(result: PushResult): boolean {
  return Object.keys(result.failedSubmodules).length > 0;
}

export function formatFailureSummary(result: PushResult): string {
  return Object.entries(result.failedSubmodules)
    .map(([repo, err]) => `${repo}: ${err}`)
    .join('; ');
}

export function upsertManagedHookBlock(existingContent: string, managedBlock: string): string {
  const base = existingContent ?? '';
  const beginIdx = base.indexOf(HOOK_BEGIN_MARKER);
  const endIdx = beginIdx >= 0 ? base.indexOf(HOOK_END_MARKER, beginIdx) : -1;
  if (beginIdx >= 0 && endIdx >= beginIdx) {
    const afterEnd = endIdx + HOOK_END_MARKER.length;
    return `${base.slice(0, beginIdx)}${managedBlock}${base.slice(afterEnd)}`;
  }
  if (!base.trim()) {
    return `#!/usr/bin/env sh\n${managedBlock}\n`;
  }
  const separator = base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${separator}${managedBlock}\n`;
}

export function buildHookSnippet(): string {
  return [
    HOOK_BEGIN_MARKER,
    'if [ "${GITHUB_SAN_SUBMODULE_HOOK_ACTIVE:-0}" != "1" ] && [ -f .gitmodules ]; then',
    '  GITHUB_SAN_SUBMODULE_HOOK_ACTIVE=1',
    '  export GITHUB_SAN_SUBMODULE_HOOK_ACTIVE',
    '  _github_san_push_submodules() {',
    '    _parent="$1"',
    '    [ -f "$_parent/.gitmodules" ] || return 0',
    '    _paths=$(git -C "$_parent" config --file .gitmodules --get-regexp \'^submodule\\..*\\.path$\' 2>/dev/null | sed \'s/^[^ ]* //\')',
    '    [ -n "$_paths" ] || return 0',
    '    _old_ifs=$IFS',
    "    IFS='\n'",
    '    for _rel in $_paths; do',
    '      [ -n "$_rel" ] || continue',
    '      _sub="$_parent/$_rel"',
    '      [ -e "$_sub/.git" ] || continue',
    '      ( _github_san_push_submodules "$_sub" ) || return 1',
    '      _branch=$(git -C "$_sub" symbolic-ref --quiet --short HEAD 2>/dev/null || true)',
    '      [ -n "$_branch" ] || continue',
    '      if _upstream=$(git -C "$_sub" rev-parse --abbrev-ref --symbolic-full-name \'@{u}\' 2>/dev/null); then',
    '        _ahead=$(git -C "$_sub" rev-list --count "$_upstream..HEAD" 2>/dev/null || echo 0)',
    '        if [ "$_ahead" -gt 0 ]; then',
    '          git -C "$_sub" push >&2 || return 1',
    '        fi',
    '      else',
    '        _remote=$(git -C "$_sub" remote | grep -x origin || git -C "$_sub" remote | head -n 1)',
    '        if [ -n "$_remote" ] && git -C "$_sub" show-ref --verify --quiet "refs/remotes/$_remote/$_branch" 2>/dev/null; then',
    '          _ahead=$(git -C "$_sub" rev-list --count "refs/remotes/$_remote/$_branch..HEAD" 2>/dev/null || echo 0)',
    '          if [ "$_ahead" -gt 0 ]; then',
    '            git -C "$_sub" push -u "$_remote" "$_branch" >&2 || return 1',
    '          fi',
    '        fi',
    '      fi',
    '    done',
    '    IFS=$_old_ifs',
    '  }',
    '  ( _github_san_push_submodules "." ) || exit 1',
    'fi',
    HOOK_END_MARKER,
  ].join('\n');
}

async function collectSubmodulesRecursive(
  rootRepo: string,
  currentDir: string,
  visitedRoots: Set<string>,
  out: SubmoduleEntry[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const gitmodules = path.join(currentDir, '.gitmodules');
  if (!isFileSafe(gitmodules)) {
    return;
  }
  const pathsByName = await readGitmodulesPropertyMap(currentDir, 'path', env);
  if (pathsByName.size === 0) {
    return;
  }
  const branchByName = await readGitmodulesPropertyMap(currentDir, 'branch', env);
  for (const [name, rel] of pathsByName.entries()) {
    if (!rel.trim()) {
      continue;
    }
    const subRoot = path.resolve(currentDir, rel);
    if (!isDirectorySafe(subRoot) || !fs.existsSync(path.join(subRoot, '.git'))) {
      continue;
    }
    const canonicalSub = toRealOrNormalized(subRoot);
    if (visitedRoots.has(canonicalSub)) {
      continue;
    }
    visitedRoots.add(canonicalSub);
    await collectSubmodulesRecursive(rootRepo, subRoot, visitedRoots, out, env);
    out.push({
      relativePath: toUnixRelativePath(path.relative(rootRepo, subRoot)),
      root: subRoot,
      configuredBranch: branchByName.get(name),
    });
  }
}

async function readGitmodulesPropertyMap(
  dir: string,
  property: string,
  env?: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const res = await runGitQuery(
    dir,
    ['config', '--file', '.gitmodules', '--get-regexp', `^submodule\\..*\\.${property}$`],
    env,
  );
  const map = new Map<string, string>();
  if (res.exitCode !== 0 && !res.stdout.trim()) {
    return map;
  }
  const prefix = 'submodule.';
  const suffix = `.${property}`;
  for (const line of res.stdout.split(/\r?\n/)) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx <= 0) {
      continue;
    }
    const fullKey = line.slice(0, spaceIdx);
    const value = line.slice(spaceIdx + 1).trim();
    if (fullKey.startsWith(prefix) && fullKey.endsWith(suffix)) {
      const name = fullKey.slice(prefix.length, fullKey.length - suffix.length);
      map.set(name, value);
    }
  }
  return map;
}

async function computePushPlan(
  submodule: SubmoduleEntry,
  env?: NodeJS.ProcessEnv,
): Promise<PushPlan> {
  const branchRes = await runGitQuery(submodule.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
  if (branchRes.exitCode !== 0) {
    return { state: 'DETACHED' };
  }
  const branch = branchRes.stdout.trim();
  if (!branch) {
    return { state: 'DETACHED' };
  }

  const upstreamRes = await runGitQuery(
    submodule.root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    env,
  );
  if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
    const ahead = await countAheadCommits(submodule.root, upstreamRes.stdout.trim(), env);
    return {
      state: ahead > 0 ? 'NEEDS_PUSH_EXISTING_UPSTREAM' : 'UP_TO_DATE',
      branchName: branch,
    };
  }

  const remote = await resolvePreferredRemote(submodule.root, env);
  if (!remote) {
    return { state: 'NO_REMOTE', branchName: branch };
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const refCheck = await runGitQuery(submodule.root, ['show-ref', '--verify', '--quiet', remoteRef], env);
  if (refCheck.exitCode === 0) {
    const ahead = await countAheadCommits(submodule.root, `${remote}/${branch}`, env);
    return {
      state: ahead > 0 ? 'NEEDS_PUSH_SET_UPSTREAM' : 'UP_TO_DATE',
      remoteName: remote,
      branchName: branch,
    };
  }

  if (branch === submodule.configuredBranch && (await hasValidHeadCommit(submodule.root, env))) {
    return {
      state: 'NEEDS_PUSH_SET_UPSTREAM',
      remoteName: remote,
      branchName: branch,
    };
  }
  return { state: 'UNTRACKED_BRANCH', remoteName: remote, branchName: branch };
}

function executeSubmodulePush(
  subRoot: string,
  plan: PushPlan,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  if (plan.state === 'NEEDS_PUSH_SET_UPSTREAM' && plan.remoteName && plan.branchName) {
    return runGitPush(subRoot, ['push', '-u', plan.remoteName, plan.branchName], env);
  }
  return runGitPush(subRoot, ['push'], env);
}

async function countAheadCommits(
  subRoot: string,
  upstreamRef: string,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const res = await runGitQuery(subRoot, ['rev-list', '--count', `${upstreamRef}..HEAD`], env);
  if (res.exitCode !== 0) {
    return 0;
  }
  const parsed = Number.parseInt(res.stdout.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function hasValidHeadCommit(subRoot: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const res = await runGitQuery(subRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], env);
  return res.exitCode === 0;
}

async function resolvePreferredRemote(
  subRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const res = await runGitQuery(subRoot, ['remote'], env);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return null;
  }
  const remotes = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) {
    return 'origin';
  }
  return remotes.length === 1 ? remotes[0] : null;
}

async function checkCustomHooksPath(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const res = await runGitQuery(repoRoot, ['config', '--get', 'core.hooksPath'], env);
  if (res.exitCode === 0 && res.stdout.trim()) {
    return `Git core.hooksPath is set to '${res.stdout.trim()}', which may override .git/hooks/pre-push.`;
  }
  return undefined;
}

async function resolveDefaultHooksDir(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const res = await runGitQuery(repoRoot, ['rev-parse', '--git-common-dir'], env);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    throw new Error(extractError(res, `Not a Git repository: ${repoRoot}`));
  }
  const rawCommonDir = res.stdout.trim();
  const commonDir = path.isAbsolute(rawCommonDir)
    ? rawCommonDir
    : path.resolve(repoRoot, rawCommonDir);
  return path.join(commonDir, 'hooks');
}

function runGitQuery(
  repoRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return runGitWithOptions(repoRoot, args, { timeoutMs: GIT_QUERY_TIMEOUT_MS, env });
}

function runGitPush(
  repoRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return runGitWithOptions(repoRoot, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS, env });
}

function emptyResult(skippedBecauseConfigured: boolean): PushResult {
  return {
    pushedSubmodules: [],
    skippedDetachedSubmodules: [],
    failedSubmodules: {},
    skippedBecauseConfigured,
  };
}

function normalizeExcludedRoots(excludedRoots?: ReadonlySet<string>): Set<string> {
  const normalized = new Set<string>();
  if (!excludedRoots) {
    return normalized;
  }
  for (const p of excludedRoots) {
    if (p) {
      normalized.add(toRealOrNormalized(p));
    }
  }
  return normalized;
}

function toRealOrNormalized(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
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

function extractError(result: CommandResult, fallback: string): string {
  const err = result.stderr.trim();
  if (err) {
    return err;
  }
  const out = result.stdout.trim();
  return out || fallback;
}
