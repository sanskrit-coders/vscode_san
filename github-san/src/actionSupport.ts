import { LineRange } from './gitHubUrlResolver';

export interface UriLike {
  readonly scheme: string;
  readonly fsPath: string;
}

export interface SelectionLike {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface ActiveEditorContextLike {
  readonly uri: UriLike;
  readonly selection: SelectionLike;
}

export interface ExtractedSelection {
  readonly paths: readonly string[];
  readonly invokedFromEditor: boolean;
}

/**
 * Extracts normalized local filesystem paths and determines whether a command invocation
 * originated from an active editor context (where line anchors should be included).
 *
 * Handles VS Code's heterogeneous menu argument signatures:
 * - Explorer context: `(clickedUri, selectedUris[])`
 * - Editor / Tab context: `(editorUri)`
 * - SCM resource context: `(...resourceStates)` where each has `.resourceUri`
 * - Command Palette: `()` falling back to `activeEditor`
 */
export function extractFilePaths(
  args: readonly unknown[],
  activeEditor: ActiveEditorContextLike | null | undefined,
): ExtractedSelection {
  const seen = new Set<string>();
  const paths: string[] = [];

  const pushUri = (candidate: unknown): void => {
    const uri = unwrapUri(candidate);
    if (uri && uri.scheme === 'file' && uri.fsPath && !seen.has(uri.fsPath)) {
      seen.add(uri.fsPath);
      paths.push(uri.fsPath);
    }
  };

  if (args.length >= 2 && Array.isArray(args[1]) && args[1].length > 0) {
    for (const item of args[1]) {
      pushUri(item);
    }
    return { paths, invokedFromEditor: false };
  }

  for (const arg of args) {
    pushUri(arg);
  }

  if (paths.length === 0 && activeEditor?.uri.scheme === 'file' && activeEditor.uri.fsPath) {
    return { paths: [activeEditor.uri.fsPath], invokedFromEditor: true };
  }

  const fromScmState = args.some(isResourceStateLike);
  const invokedFromEditor =
    !fromScmState &&
    paths.length === 1 &&
    activeEditor !== null &&
    activeEditor !== undefined &&
    activeEditor.uri.scheme === 'file' &&
    activeEditor.uri.fsPath === paths[0];

  return { paths, invokedFromEditor };
}

/**
 * Converts a 0-based VS Code editor selection into a 1-based inclusive GitHub `#L...` line range.
 */
export function toLineRange(selection: SelectionLike): LineRange {
  const begin = selection.startLine;
  let end = selection.endLine;
  if (end > begin && selection.endCharacter === 0) {
    end -= 1;
  }
  return {
    oneBasedStart: begin + 1,
    oneBasedEnd: end + 1,
  };
}

function unwrapUri(candidate: unknown): UriLike | null {
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.scheme === 'string' && typeof obj.fsPath === 'string') {
    return { scheme: obj.scheme, fsPath: obj.fsPath };
  }
  if (obj.resourceUri && typeof obj.resourceUri === 'object') {
    return unwrapUri(obj.resourceUri);
  }
  return null;
}

function isResourceStateLike(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const obj = candidate as Record<string, unknown>;
  return 'resourceUri' in obj && !(typeof obj.scheme === 'string' && typeof obj.fsPath === 'string');
}
