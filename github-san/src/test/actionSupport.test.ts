import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFilePaths, toLineRange } from '../actionSupport';

test('extractFilePaths handles explorer single, multi-select, SCM, editor, and palette invocations', () => {
  const editor = {
    uri: { scheme: 'file', fsPath: '/repo/a.md' },
    selection: { startLine: 4, startCharacter: 2, endLine: 7, endCharacter: 0 },
  };

  // Explorer single-click with selected array
  assert.deepEqual(
    extractFilePaths(
      [
        { scheme: 'file', fsPath: '/repo/a.md' },
        [{ scheme: 'file', fsPath: '/repo/a.md' }],
      ],
      editor,
    ),
    { paths: ['/repo/a.md'], invokedFromEditor: false },
  );

  // Explorer multi-select (two files)
  assert.deepEqual(
    extractFilePaths(
      [
        { scheme: 'file', fsPath: '/repo/a.md' },
        [
          { scheme: 'file', fsPath: '/repo/a.md' },
          { scheme: 'file', fsPath: '/repo/b.md' },
        ],
      ],
      editor,
    ),
    { paths: ['/repo/a.md', '/repo/b.md'], invokedFromEditor: false },
  );

  // Editor context / tab click on the active file includes line anchor flag
  assert.deepEqual(extractFilePaths([{ scheme: 'file', fsPath: '/repo/a.md' }], editor), {
    paths: ['/repo/a.md'],
    invokedFromEditor: true,
  });

  // Command palette falls back to active editor
  assert.deepEqual(extractFilePaths([], editor), {
    paths: ['/repo/a.md'],
    invokedFromEditor: true,
  });

  // SCM resourceState context does not attach editor line anchors
  assert.deepEqual(
    extractFilePaths([{ resourceUri: { scheme: 'file', fsPath: '/repo/a.md' } }], editor),
    { paths: ['/repo/a.md'], invokedFromEditor: false },
  );

  // Non-file schemes ignored cleanly
  assert.deepEqual(
    extractFilePaths([{ scheme: 'untitled', fsPath: 'Untitled-1' }], null),
    { paths: [], invokedFromEditor: false },
  );
});

test('toLineRange converts 0-based selections and trims trailing whole-line newline', () => {
  assert.deepEqual(
    toLineRange({ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 }),
    { oneBasedStart: 1, oneBasedEnd: 1 },
  );
  assert.deepEqual(
    toLineRange({ startLine: 4, startCharacter: 0, endLine: 7, endCharacter: 0 }),
    { oneBasedStart: 5, oneBasedEnd: 7 },
  );
  assert.deepEqual(
    toLineRange({ startLine: 4, startCharacter: 0, endLine: 7, endCharacter: 5 }),
    { oneBasedStart: 5, oneBasedEnd: 8 },
  );
});
