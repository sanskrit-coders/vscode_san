import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ActiveEditorContextLike,
  extractFilePaths,
  toLineRange,
} from './actionSupport';
import {
  DiffPlan,
  launchDiffSan,
  planSelection,
  resolveExecutable,
} from './diffSanSupport';
import { findGitLocation, LineRange, resolveGithubUrl } from './gitHubUrlResolver';
import {
  discoverSubmodulesBottomUp,
  enableGlobalRecurseSubmodules,
  formatFailureSummary,
  hasFailures,
  installPrePushHook,
  pushPendingSubmodules,
  pushSubmodulesAndRepo,
  resolveTargetRepoRoot,
} from './submodulePushSupport';

interface GitHeadState {
  readonly name?: string;
  readonly ahead?: number;
}

interface GitRepositoryLike {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: GitHeadState;
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitApiLike {
  readonly repositories: readonly GitRepositoryLike[];
  readonly onDidOpenRepository: vscode.Event<GitRepositoryLike>;
  readonly onDidCloseRepository: vscode.Event<GitRepositoryLike>;
  registerPostCommitCommandsProvider?: (provider: {
    getCommands(repository: GitRepositoryLike): vscode.Command[];
  }) => vscode.Disposable;
}

interface GitExtensionExportsLike {
  getAPI(version: number): GitApiLike;
}

/**
 * Registers Github-san commands for opening/copying submodule GitHub URLs,
 * launching `diff_san`, and pushing/configuring Git submodules cleanly.
 */
export function activate(context: vscode.ExtensionContext): void {
  const activeExtensionPushes = new Set<string>();

  context.subscriptions.push(
    vscode.commands.registerCommand('githubSan.openInBrowser', async (...args: unknown[]) => {
      await handleGithubUrlCommand(args, async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      });
    }),
    vscode.commands.registerCommand('githubSan.copyUrl', async (...args: unknown[]) => {
      await handleGithubUrlCommand(args, async (url) => {
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`GitHub URL copied: ${url}`);
      });
    }),
    vscode.commands.registerCommand('githubSan.diffWithDiffSan', async (...args: unknown[]) => {
      await handleDiffWithDiffSan(args);
    }),
    vscode.commands.registerCommand('githubSan.pushWithSubmodules', async (...args: unknown[]) => {
      await handlePushWithSubmodules(args, activeExtensionPushes);
    }),
    vscode.commands.registerCommand('githubSan.enableSubmoduleAutoPush', async (...args: unknown[]) => {
      await handleEnableSubmoduleAutoPush(args);
    }),
  );

  void setupGitExtensionIntegration(context, activeExtensionPushes);
}

export function deactivate(): void {}

async function handleGithubUrlCommand(
  args: readonly unknown[],
  onSuccess: (url: string) => Promise<void>,
): Promise<void> {
  const editorCtx = getActiveEditorContext();
  const extracted = extractFilePaths(args, editorCtx);
  const targetPath = extracted.paths[0];
  if (!targetPath) {
    vscode.window.showWarningMessage('Select a local file or folder inside a Git repository first.');
    return;
  }

  let lineRange: LineRange | null = null;
  if (extracted.invokedFromEditor && editorCtx) {
    lineRange = toLineRange(editorCtx.selection);
  }

  try {
    const url = await resolveGithubUrl(targetPath, lineRange);
    await onSuccess(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Github-san failed: ${message}`);
  }
}

async function handleDiffWithDiffSan(args: readonly unknown[]): Promise<void> {
  const editorCtx = getActiveEditorContext();
  const extracted = extractFilePaths(args, editorCtx);
  let targetPaths = [...extracted.paths];

  if (targetPaths.length === 0) {
    const workspaceDirs = getLocalWorkspaceDirs();
    if (workspaceDirs.length === 1) {
      targetPaths = [workspaceDirs[0]];
    }
  }

  const plan = planSelection(targetPaths);
  if (!plan) {
    vscode.window.showWarningMessage(
      'Select a file/directory inside a Git repository (diff against HEAD), or select two files to compare with diff_san.',
    );
    return;
  }

  await saveUnsavedDocuments(targetPaths, plan);

  const configPath = vscode.workspace
    .getConfiguration('githubSan')
    .get<string>('diffSanExecutable');
  const executable = resolveExecutable({ configPath, workspaceDirs: getLocalWorkspaceDirs() });

  const result = await launchDiffSan(executable, plan);
  if (!result.started) {
    vscode.window.showErrorMessage(`diff_san failed: ${result.errorMessage ?? 'Unknown error'}`);
  }
}

async function handlePushWithSubmodules(
  args: readonly unknown[],
  activeExtensionPushes: Set<string>,
): Promise<void> {
  const repoRoot = resolveCommandRepoRoot(args);
  if (!repoRoot) {
    vscode.window.showWarningMessage('Open or select a local Git repository first.');
    return;
  }

  await saveAllDirtyLocalDocuments();

  activeExtensionPushes.add(repoRoot);
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pushing submodules & ${path.basename(repoRoot)}`,
        cancellable: true,
      },
      async (progress, token) =>
        pushSubmodulesAndRepo(repoRoot, {
          isCancelled: () => token.isCancellationRequested,
          onProgress: (message) => progress.report({ message }),
        }),
    );

    if (hasFailures(result)) {
      vscode.window.showErrorMessage(`Push Submodules & Repository failed: ${formatFailureSummary(result)}`);
      return;
    }

    const summary =
      result.pushedSubmodules.length > 0
        ? `Pushed ${result.pushedSubmodules.length} submodule(s) (${result.pushedSubmodules.join(', ')}) and ${path.basename(repoRoot)}.`
        : `Pushed repository ${path.basename(repoRoot)}.`;
    vscode.window.showInformationMessage(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes('cancelled')) {
      vscode.window.showErrorMessage(`Push Submodules & Repository failed: ${message}`);
    }
  } finally {
    setTimeout(() => activeExtensionPushes.delete(repoRoot), 5000);
  }
}

async function handleEnableSubmoduleAutoPush(args: readonly unknown[]): Promise<void> {
  const repoRoots = collectWorkspaceRepoRootsWithSubmodules(args);
  const items: Array<{ label: string; description: string; setGlobal: boolean; installHook: boolean }> =
    repoRoots.length > 0
      ? [
          {
            label: 'Global Git Config + Repository pre-push Hook (Recommended)',
            description: 'Sets global push.recurseSubmodules=on-demand and installs bottom-up .git/hooks/pre-push',
            setGlobal: true,
            installHook: true,
          },
          {
            label: 'Global Git Config Only',
            description: 'Runs git config --global push.recurseSubmodules on-demand',
            setGlobal: true,
            installHook: false,
          },
          {
            label: 'Repository pre-push Hook Only',
            description: `Installs bottom-up pre-push hook in ${repoRoots.length} repository/repositories`,
            setGlobal: false,
            installHook: true,
          },
        ]
      : [
          {
            label: 'Enable Global Git Submodule Auto-Push',
            description: 'Runs git config --global push.recurseSubmodules on-demand',
            setGlobal: true,
            installHook: false,
          },
        ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose how Git should auto-push submodules',
  });
  if (!picked) {
    return;
  }

  try {
    const messages: string[] = [];
    let hasWarning = false;

    if (picked.setGlobal) {
      await enableGlobalRecurseSubmodules(repoRoots[0]);
      messages.push('Configured git config --global push.recurseSubmodules on-demand.');
    }
    if (picked.installHook) {
      const hookPaths: string[] = [];
      for (const root of repoRoots) {
        const res = await installPrePushHook(root);
        hookPaths.push(res.hookFile);
        if (res.customHooksPathWarning) {
          hasWarning = true;
          messages.push(res.customHooksPathWarning);
        }
      }
      if (hookPaths.length > 0) {
        messages.push(`Installed pre-push hook(s): ${hookPaths.join(', ')}.`);
      }
    }

    if (hasWarning) {
      vscode.window.showWarningMessage(messages.join(' '));
    } else {
      vscode.window.showInformationMessage(messages.join(' '));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to configure Git submodule auto-push: ${message}`);
  }
}

async function setupGitExtensionIntegration(
  context: vscode.ExtensionContext,
  activeExtensionPushes: Set<string>,
): Promise<void> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionExportsLike>('vscode.git');
  if (!gitExtension) {
    return;
  }
  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const gitApi = exports?.getAPI?.(1);
  if (!gitApi) {
    return;
  }

  if (typeof gitApi.registerPostCommitCommandsProvider === 'function') {
    context.subscriptions.push(
      gitApi.registerPostCommitCommandsProvider({
        getCommands(repository: GitRepositoryLike): vscode.Command[] {
          const root = repository.rootUri?.scheme === 'file' ? repository.rootUri.fsPath : '';
          if (!root || !fs.existsSync(path.join(root, '.gitmodules'))) {
            return [];
          }
          return [
            {
              command: 'githubSan.pushWithSubmodules',
              title: 'Commit & Push Submodules + Repo',
              tooltip: 'Commit, then push ahead submodules bottom-up and push this repository',
            },
          ];
        },
      }),
    );
  }

  const repoWatchers = new Map<string, vscode.Disposable>();
  const syncInFlight = new Set<string>();

  const attachRepo = (repo: GitRepositoryLike) => {
    if (repo.rootUri?.scheme !== 'file') {
      return;
    }
    const repoRoot = path.resolve(repo.rootUri.fsPath);
    if (repoWatchers.has(repoRoot)) {
      return;
    }
    let lastAhead = repo.state.HEAD?.ahead ?? 0;
    let lastBranch = repo.state.HEAD?.name;

    const sub = repo.state.onDidChange(() => {
      const curAhead = repo.state.HEAD?.ahead ?? 0;
      const curBranch = repo.state.HEAD?.name;
      const justFinishedPush =
        lastAhead > 0 && curAhead === 0 && Boolean(lastBranch) && lastBranch === curBranch;
      lastAhead = curAhead;
      lastBranch = curBranch;

      if (!justFinishedPush || activeExtensionPushes.has(repoRoot) || syncInFlight.has(repoRoot)) {
        return;
      }
      if (!fs.existsSync(path.join(repoRoot, '.gitmodules'))) {
        return;
      }
      const autoEnabled = vscode.workspace
        .getConfiguration('githubSan')
        .get<boolean>('autoPushSubmodules', true);
      if (!autoEnabled) {
        return;
      }

      syncInFlight.add(repoRoot);
      void autoPushSubmodulesSilently(repoRoot, gitApi).finally(() => {
        syncInFlight.delete(repoRoot);
      });
    });

    repoWatchers.set(repoRoot, sub);
    context.subscriptions.push(sub);
  };

  for (const repo of gitApi.repositories) {
    attachRepo(repo);
  }
  context.subscriptions.push(gitApi.onDidOpenRepository(attachRepo));
  context.subscriptions.push(
    gitApi.onDidCloseRepository((repo) => {
      if (repo.rootUri?.scheme !== 'file') {
        return;
      }
      const repoRoot = path.resolve(repo.rootUri.fsPath);
      const sub = repoWatchers.get(repoRoot);
      if (sub) {
        sub.dispose();
        repoWatchers.delete(repoRoot);
      }
    }),
  );
}

async function autoPushSubmodulesSilently(repoRoot: string, gitApi: GitApiLike): Promise<void> {
  try {
    const submodules = await discoverSubmodulesBottomUp(repoRoot);
    if (submodules.length === 0) {
      return;
    }
    const result = await pushPendingSubmodules(repoRoot, {
      mode: 'autoWhenNotConfigured',
    });
    if (hasFailures(result)) {
      vscode.window.showErrorMessage(`Submodule Auto-Push Failed: ${formatFailureSummary(result)}`);
      return;
    }
    if (result.pushedSubmodules.length > 0 && gitApi.repositories.length > 0) {
      void vscode.commands.executeCommand('git.refresh');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Submodule Auto-Push Failed: ${message}`);
  }
}

function resolveCommandRepoRoot(args: readonly unknown[]): string | null {
  const fromScm = extractScmRootPath(args);
  if (fromScm) {
    return fromScm;
  }
  const editorCtx = getActiveEditorContext();
  const extracted = extractFilePaths(args, editorCtx);
  return resolveTargetRepoRoot(extracted.paths, getLocalWorkspaceDirs());
}

function extractScmRootPath(args: readonly unknown[]): string | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') {
      continue;
    }
    const candidate = arg as { rootUri?: unknown; resourceUri?: unknown };
    if (candidate.rootUri && isFileUri(candidate.rootUri)) {
      const loc = findGitLocation(candidate.rootUri.fsPath);
      if (loc) {
        return loc.repoRoot;
      }
    }
  }
  return null;
}

function collectWorkspaceRepoRootsWithSubmodules(args: readonly unknown[]): string[] {
  const roots = new Set<string>();
  const primary = resolveCommandRepoRoot(args);
  if (primary) {
    roots.add(primary);
  }
  for (const dir of getLocalWorkspaceDirs()) {
    const loc = findGitLocation(dir);
    if (loc && fs.existsSync(path.join(loc.repoRoot, '.gitmodules'))) {
      roots.add(loc.repoRoot);
    }
  }
  return [...roots];
}

function isFileUri(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const maybeUri = value as { scheme?: unknown; fsPath?: unknown };
  return maybeUri.scheme === 'file' && typeof maybeUri.fsPath === 'string';
}

function getLocalWorkspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
}

async function saveAllDirtyLocalDocuments(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === 'file') {
      await doc.save();
    }
  }
}

async function saveUnsavedDocuments(targetPaths: readonly string[], plan: DiffPlan): Promise<void> {
  if (plan.mode === 'HEAD_DIRECTORY') {
    const targetDirs = targetPaths.map((p) => path.resolve(p));
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== 'file') {
        continue;
      }
      const docPath = path.resolve(doc.uri.fsPath);
      if (targetDirs.some((dir) => docPath === dir || docPath.startsWith(dir + path.sep))) {
        await doc.save();
      }
    }
    return;
  }

  const targetSet = new Set(targetPaths.map((p) => path.resolve(p)));
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === 'file' && targetSet.has(path.resolve(doc.uri.fsPath))) {
      await doc.save();
    }
  }
}

function getActiveEditorContext(): ActiveEditorContextLike | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  return {
    uri: {
      scheme: editor.document.uri.scheme,
      fsPath: editor.document.uri.fsPath,
    },
    selection: {
      startLine: editor.selection.start.line,
      startCharacter: editor.selection.start.character,
      endLine: editor.selection.end.line,
      endCharacter: editor.selection.end.character,
    },
  };
}
