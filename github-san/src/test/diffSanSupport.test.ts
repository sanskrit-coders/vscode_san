import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  extractRunningUrl,
  launchDiffSan,
  planSelection,
  resolveExecutable,
} from '../diffSanSupport';

test('planSelection plans single file and directory inside git repo and submodule', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-diffsan-git-'));
  try {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const subDir = path.join(tempDir, 'docs');
    fs.mkdirSync(subDir);
    const file = path.join(subDir, 'sample.md');
    fs.writeFileSync(file, 'om', 'utf8');

    const filePlan = planSelection([file]);
    assert.ok(filePlan);
    assert.equal(filePlan.mode, 'HEAD_SINGLE_FILE');
    assert.equal(filePlan.label, 'Diff against HEAD (diff_san)');
    assert.deepEqual(filePlan.arguments, [path.resolve(file)]);

    const dirPlan = planSelection([subDir]);
    assert.ok(dirPlan);
    assert.equal(dirPlan.mode, 'HEAD_DIRECTORY');
    assert.equal(dirPlan.label, 'Diff Directory against HEAD (diff_san)');
    assert.deepEqual(dirPlan.arguments, [path.resolve(subDir)]);

    // Submodule pointer
    const subMod = path.join(tempDir, 'submod');
    const modGit = path.join(tempDir, '.git', 'modules', 'submod');
    fs.mkdirSync(modGit, { recursive: true });
    fs.mkdirSync(subMod);
    fs.writeFileSync(path.join(subMod, '.git'), 'gitdir: ../.git/modules/submod\n', 'utf8');
    const subFile = path.join(subMod, 'sutra.md');
    fs.writeFileSync(subFile, 'om', 'utf8');

    const subPlan = planSelection([subFile]);
    assert.ok(subPlan);
    assert.equal(subPlan.mode, 'HEAD_SINGLE_FILE');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('planSelection handles non-git, two-file pairs, and multi-file --head', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-diffsan-multi-'));
  try {
    const a = path.join(tempDir, 'a.md');
    const b = path.join(tempDir, 'b.md');
    const dir = path.join(tempDir, 'folder');
    fs.mkdirSync(dir);
    fs.writeFileSync(a, 'a', 'utf8');
    fs.writeFileSync(b, 'b', 'utf8');

    assert.equal(planSelection([a]), null);
    assert.equal(planSelection([dir]), null);
    assert.equal(planSelection([path.join(tempDir, 'missing.md')]), null);

    const pairPlan = planSelection([a, b]);
    assert.ok(pairPlan);
    assert.equal(pairPlan.mode, 'TWO_FILES');
    assert.equal(pairPlan.label, 'Diff Two Files (diff_san)');
    assert.deepEqual(pairPlan.arguments, [a, b]);

    assert.equal(planSelection([a, dir]), null);

    // Three files: requires all to be inside Git repos
    const repo = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const f1 = path.join(repo, '1.md');
    const f2 = path.join(repo, '2.md');
    const f3 = path.join(repo, '3.md');
    fs.writeFileSync(f1, '1', 'utf8');
    fs.writeFileSync(f2, '2', 'utf8');
    fs.writeFileSync(f3, '3', 'utf8');

    const multiPlan = planSelection([f1, f2, f3]);
    assert.ok(multiPlan);
    assert.equal(multiPlan.mode, 'HEAD_MULTI_FILES');
    assert.deepEqual(multiPlan.arguments, ['--head', f1, f2, f3]);

    assert.equal(planSelection([f1, f2, a]), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveExecutable respects settings, env, PATH, workspace venv, and user fallbacks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-diffsan-bin-'));
  try {
    const fakeHome = path.join(tempDir, 'home');
    const wsDir = path.join(tempDir, 'ws');
    const pathBin = path.join(tempDir, 'pathbin');
    const cfgExe = path.join(tempDir, 'cfg', 'custom-diff');
    const envExe = path.join(tempDir, 'env', 'env-diff');
    const pathExe = path.join(pathBin, 'local-diff-san');
    const wsExe = path.join(wsDir, '.venv', 'bin', 'local-diff-san');
    const gitlandExe = path.join(fakeHome, 'gitland', 'python_venv', 'bin', 'local-diff-san');
    const localExe = path.join(fakeHome, '.local', 'bin', 'local_diff_san');

    for (const exe of [cfgExe, envExe, pathExe, wsExe, gitlandExe, localExe]) {
      writeExecutable(exe, '#!/bin/sh\nexit 0\n');
    }

    assert.equal(
      resolveExecutable({
        configPath: cfgExe,
        envOverride: envExe,
        pathEnv: pathBin,
        userHome: fakeHome,
        workspaceDirs: [wsDir],
      }),
      cfgExe,
    );
    assert.equal(
      resolveExecutable({
        envOverride: envExe,
        pathEnv: pathBin,
        userHome: fakeHome,
        workspaceDirs: [wsDir],
      }),
      envExe,
    );
    assert.equal(
      resolveExecutable({
        pathEnv: pathBin,
        userHome: fakeHome,
        workspaceDirs: [wsDir],
      }),
      pathExe,
    );
    assert.equal(
      resolveExecutable({
        pathEnv: '',
        userHome: fakeHome,
        workspaceDirs: [wsDir],
      }),
      wsExe,
    );
    assert.equal(
      resolveExecutable({
        pathEnv: '',
        userHome: fakeHome,
        workspaceDirs: [],
      }),
      gitlandExe,
    );

    fs.rmSync(gitlandExe);
    assert.equal(
      resolveExecutable({
        pathEnv: '',
        userHome: fakeHome,
        workspaceDirs: [],
      }),
      localExe,
    );

    assert.equal(
      resolveExecutable({
        pathEnv: '',
        userHome: path.join(tempDir, 'empty'),
        workspaceDirs: [],
      }),
      null,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('launchDiffSan captures running URL, non-zero exit failures, and missing executable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-diffsan-launch-'));
  try {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const target = path.join(tempDir, 'text.md');
    fs.writeFileSync(target, 'om', 'utf8');
    const plan = planSelection([target]);
    assert.ok(plan);

    assert.equal(
      extractRunningUrl('local-diff-san running at http://127.0.0.1:8775/ (mode=git_head)\n'),
      'http://127.0.0.1:8775/',
    );

    const okScript = path.join(tempDir, 'ok-diff');
    writeExecutable(
      okScript,
      "#!/bin/sh\necho 'local-diff-san running at http://127.0.0.1:8799/ (mode=git_head)'\nsleep 0.2\n",
    );
    const okRes = await launchDiffSan(okScript, plan, 3000);
    assert.equal(okRes.started, true);
    assert.equal(okRes.url, 'http://127.0.0.1:8799/');

    const failScript = path.join(tempDir, 'fail-diff');
    writeExecutable(
      failScript,
      "#!/bin/sh\necho 'Error: Not inside a git repository' >&2\nexit 2\n",
    );
    const failRes = await launchDiffSan(failScript, plan, 3000);
    assert.equal(failRes.started, false);
    assert.ok(failRes.errorMessage?.includes('code 2'));
    assert.ok(failRes.errorMessage?.includes('Not inside a git repository'));

    const missingRes = await launchDiffSan(null, plan, 1000);
    assert.equal(missingRes.started, false);
    assert.ok(missingRes.errorMessage?.includes('local-diff-san'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeExecutable(target: string, body: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  fs.chmodSync(target, 0o755);
}
