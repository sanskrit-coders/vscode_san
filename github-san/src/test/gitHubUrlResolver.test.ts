import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  encodePathSegments,
  findGitLocation,
  parseGithubBaseUrl,
  readRemoteUrlsFromConfig,
  resolveGithubUrl,
} from '../gitHubUrlResolver';

test('parseGithubBaseUrl handles standard and SCP remotes', () => {
  assert.equal(
    parseGithubBaseUrl('https://github.com/vishvAsa/vedAH_yajuH.git'),
    'https://github.com/vishvAsa/vedAH_yajuH',
  );
  assert.equal(
    parseGithubBaseUrl('git@github.com:vishvAsa/vedAH_yajuH.git'),
    'https://github.com/vishvAsa/vedAH_yajuH',
  );
  assert.equal(
    parseGithubBaseUrl('ssh://git@github.com/sanskrit-coders/vscode_san.git'),
    'https://github.com/sanskrit-coders/vscode_san',
  );
  assert.equal(
    parseGithubBaseUrl('git://github.com/vishvAsa/sanskrit/'),
    'https://github.com/vishvAsa/sanskrit',
  );
  assert.equal(parseGithubBaseUrl('https://gitlab.com/org/repo.git'), null);
  assert.equal(parseGithubBaseUrl('https://github.com/onlyowner'), null);
  assert.equal(parseGithubBaseUrl(''), null);
});

test('encodePathSegments encodes Devanagari and spaces while keeping slashes', () => {
  assert.equal(
    encodePathSegments('content/वैखानसः/my file.md'),
    'content/%E0%A4%B5%E0%A5%88%E0%A4%96%E0%A4%BE%E0%A4%A8%E0%A4%B8%E0%A4%83/my%20file.md',
  );
});

test('resolveGithubUrl resolves files, directories, and line anchors inside repo and submodule', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ghsan-repo-'));
  try {
    const superDir = path.join(tempRoot, 'super');
    fs.mkdirSync(superDir);
    initCommitRepo(superDir, 'master', 'git@github.com:vishvAsa/super_repo.git', {
      'README.md': 'root\n',
    });

    // Separate repo inside superDir acting like an embedded submodule checkout via .git pointer file.
    const bareSubGit = path.join(superDir, '.git', 'modules', 'content');
    fs.mkdirSync(path.dirname(bareSubGit), { recursive: true });
    const subCheckout = path.join(tempRoot, 'sub_src');
    fs.mkdirSync(subCheckout);
    initCommitRepo(subCheckout, 'content', 'https://github.com/vishvAsa/vedAH_yajuH.git', {
      'taittirIyam/आह्निकम्.md': 'line1\nline2\n',
    });

    // Wire superDir/content/.git -> ../.git/modules/content by moving .git directory.
    const subTargetDir = path.join(superDir, 'content');
    fs.mkdirSync(subTargetDir);
    fs.cpSync(path.join(subCheckout, 'taittirIyam'), path.join(subTargetDir, 'taittirIyam'), {
      recursive: true,
    });
    fs.renameSync(path.join(subCheckout, '.git'), bareSubGit);
    fs.writeFileSync(path.join(subTargetDir, '.git'), 'gitdir: ../.git/modules/content\n', 'utf8');

    const loc = findGitLocation(path.join(subTargetDir, 'taittirIyam', 'आह्निकम्.md'));
    assert.ok(loc);
    assert.equal(loc.repoRoot, subTargetDir);
    assert.equal(loc.gitDir, bareSubGit);

    // Submodule file defaults to HEAD SHA when no remote tracking ref exists locally.
    const sha = runGitSync(subTargetDir, 'rev-parse', 'HEAD');
    const singleLineUrl = await resolveGithubUrl(
      path.join(subTargetDir, 'taittirIyam', 'आह्निकम्.md'),
      { oneBasedStart: 2, oneBasedEnd: 2 },
    );
    assert.equal(
      singleLineUrl,
      `https://github.com/vishvAsa/vedAH_yajuH/blob/${sha}/taittirIyam/${encodeURIComponent('आह्निकम्.md')}#L2`,
    );

    const rangeUrl = await resolveGithubUrl(
      path.join(subTargetDir, 'taittirIyam', 'आह्निकम्.md'),
      { oneBasedStart: 1, oneBasedEnd: 2 },
    );
    assert.equal(
      rangeUrl,
      `https://github.com/vishvAsa/vedAH_yajuH/blob/${sha}/taittirIyam/${encodeURIComponent('आह्निकम्.md')}#L1-L2`,
    );

    // Simulated remote tracking ref resolves clean branch name.
    runGitSync(subTargetDir, 'update-ref', 'refs/remotes/origin/content', sha);
    runGitSync(subTargetDir, 'config', 'branch.content.remote', 'origin');
    runGitSync(subTargetDir, 'config', 'branch.content.merge', 'refs/heads/content');

    const branchFileUrl = await resolveGithubUrl(
      path.join(subTargetDir, 'taittirIyam', 'आह्निकम्.md'),
      null,
    );
    assert.equal(
      branchFileUrl,
      `https://github.com/vishvAsa/vedAH_yajuH/blob/content/taittirIyam/${encodeURIComponent('आह्निकम्.md')}`,
    );

    const rootDirUrl = await resolveGithubUrl(subTargetDir, null);
    assert.equal(rootDirUrl, 'https://github.com/vishvAsa/vedAH_yajuH/tree/content');

    const nestedDirUrl = await resolveGithubUrl(path.join(subTargetDir, 'taittirIyam'), null);
    assert.equal(nestedDirUrl, 'https://github.com/vishvAsa/vedAH_yajuH/tree/content/taittirIyam');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('readRemoteUrlsFromConfig resolves worktree commondir configs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ghsan-wt-'));
  try {
    const commonDir = path.join(tempRoot, 'main.git');
    const wtGitDir = path.join(commonDir, 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');
    fs.writeFileSync(
      path.join(commonDir, 'config'),
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:sanskrit-coders/vscode_san.git\n',
      'utf8',
    );

    const remotes = readRemoteUrlsFromConfig(wtGitDir);
    assert.equal(remotes.get('upstream'), 'git@github.com:sanskrit-coders/vscode_san.git');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveGithubUrl rejects non-git directories cleanly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ghsan-nongit-'));
  try {
    const file = path.join(tempRoot, 'note.md');
    fs.writeFileSync(file, 'om', 'utf8');
    assert.equal(findGitLocation(file), null);
    await assert.rejects(() => resolveGithubUrl(file), /Not inside a Git repository/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function initCommitRepo(
  dir: string,
  branch: string,
  remoteUrl: string,
  files: Record<string, string>,
): void {
  runGitSync(dir, 'init', '-b', branch);
  runGitSync(dir, 'config', 'user.email', 'test@example.com');
  runGitSync(dir, 'config', 'user.name', 'Test User');
  runGitSync(dir, 'remote', 'add', 'origin', remoteUrl);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  runGitSync(dir, 'add', '.');
  runGitSync(dir, 'commit', '-m', 'init');
}

function runGitSync(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}
