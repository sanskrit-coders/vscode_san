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
import { LineRange, resolveGithubUrl } from './gitHubUrlResolver';

/**
 * Registers Github-san commands for opening/copying submodule GitHub URLs
 * and launching `diff_san` diffs against Git `HEAD` or between two files.
 */
export function activate(context: vscode.ExtensionContext): void {
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
  );
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
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 1 && workspaceFolders[0].uri.scheme === 'file') {
      targetPaths = [workspaceFolders[0].uri.fsPath];
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
  const workspaceDirs = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  const executable = resolveExecutable({ configPath, workspaceDirs });

  const result = await launchDiffSan(executable, plan);
  if (!result.started) {
    vscode.window.showErrorMessage(`diff_san failed: ${result.errorMessage ?? 'Unknown error'}`);
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
