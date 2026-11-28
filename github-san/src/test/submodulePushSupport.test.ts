import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { runGitWithOptions } from '../gitHubUrlResolver';
import {
  discoverSubmodulesBottomUp,
  enableGlobalRecurseSubmodules,
  getEffectivePushRecurseSubmodules,
  hasFailures,
  installPrePushHook,
  pushPendingSubmodules,
  pushSubmodulesAndRepo,
  resolveTargetRepoRoot,
} from '../submodulePushSupport';

interface NestedFixture {
  readonly root: string;
  readonly superBare: string;
  readonly outerBare: string;
  readonly innerBare: string;
  readonly vendorBare: string;
  readonly superWork: string;
  readonly env: NodeJS.ProcessEnv;
}

async function gitSuccess(
  dir: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> {
  const res = await runGitWithOptions(dir, args, { timeoutMs: 30_000, env });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${res.stderr} / ${res.stdout}`);
  }
  return res.stdout.trim();
}

async function initBareRepo(bareDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  fs.mkdirSync(bareDir, { recursive: true });
  await gitSuccess(bareDir, env, 'init', '--bare', '-b', 'main');
  return bareDir;
}

async function seedBareRepo(
  bareDir: string,
  seedWork: string,
  fileName: string,
  content: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await gitSuccess(path.dirname(bareDir), env, 'clone', bareDir, seedWork);
  await gitSuccess(seedWork, env, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(seedWork, fileName), content, 'utf8');
  await gitSuccess(seedWork, env, 'add', fileName);
  await gitSuccess(seedWork, env, 'commit', '-m', `init ${fileName}`);
  await gitSuccess(seedWork, env, 'push', '-u', 'origin', 'main');
}

async function createNestedFixture(): Promise<NestedFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-githubsan-subpush-'));
  const globalCfg = path.join(root, 'gitconfig-global');
  fs.writeFileSync(globalCfg, '', 'utf8');
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  const innerBare = await initBareRepo(path.join(root, 'inner.git'), env);
  const outerBare = await initBareRepo(path.join(root, 'outer.git'), env);
  const vendorBare = await initBareRepo(path.join(root, 'vendor.git'), env);
  const superBare = await initBareRepo(path.join(root, 'super.git'), env);

  await seedBareRepo(innerBare, path.join(root, 'seed-inner'), 'inner.txt', 'inner v1\n', env);
  await seedBareRepo(vendorBare, path.join(root, 'seed-vendor'), 'vendor.txt', 'vendor v1\n', env);

  const seedOuter = path.join(root, 'seed-outer');
  await gitSuccess(root, env, 'clone', outerBare, seedOuter);
  await gitSuccess(seedOuter, env, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(seedOuter, 'outer.txt'), 'outer v1\n', 'utf8');
  await gitSuccess(seedOuter, env, 'add', 'outer.txt');
  await gitSuccess(seedOuter, env, 'commit', '-m', 'init outer');
  await gitSuccess(seedOuter, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', innerBare, 'inner');
  await gitSuccess(seedOuter, env, 'commit', '-m', 'add inner submodule');
  await gitSuccess(seedOuter, env, 'push', '-u', 'origin', 'main');

  const seedSuper = path.join(root, 'seed-super');
  await gitSuccess(root, env, 'clone', superBare, seedSuper);
  await gitSuccess(seedSuper, env, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(seedSuper, 'README.md'), 'super v1\n', 'utf8');
  await gitSuccess(seedSuper, env, 'add', 'README.md');
  await gitSuccess(seedSuper, env, 'commit', '-m', 'init super');
  await gitSuccess(seedSuper, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', outerBare, 'outer');
  await gitSuccess(seedSuper, env, '-c', 'protocol.file.allow=always', 'submodule', 'add', vendorBare, 'vendor');
  await gitSuccess(seedSuper, env, 'commit', '-m', 'add outer and vendor submodules');
  await gitSuccess(seedSuper, env, 'push', '-u', 'origin', 'main');

  const superWork = path.join(root, 'work-super');
  await gitSuccess(
    root,
    env,
    '-c',
    'protocol.file.allow=always',
    'clone',
    '--recurse-submodules',
    superBare,
    superWork,
  );
  await gitSuccess(path.join(superWork, 'outer'), env, 'checkout', '-B', 'main', '--track', 'origin/main');
  await gitSuccess(path.join(superWork, 'outer/inner'), env, 'checkout', '-B', 'main', '--track', 'origin/main');

  return { root, superBare, outerBare, innerBare, vendorBare, superWork, env };
}

test('discoverSubmodulesBottomUp and pushPendingSubmodules auto-push bottom-up when unset', async () => {
  const f = await createNestedFixture();
  try {
    const discovered = await discoverSubmodulesBottomUp(f.superWork, f.env);
    assert.deepEqual(
      discovered.map((d) => d.relativePath),
      ['outer/inner', 'outer', 'vendor'],
    );

    const innerWork = path.join(f.superWork, 'outer/inner');
    fs.writeFileSync(path.join(innerWork, 'inner.txt'), 'inner v2\n', 'utf8');
    await gitSuccess(innerWork, f.env, 'commit', '-am', 'inner v2');

    const outerWork = path.join(f.superWork, 'outer');
    fs.writeFileSync(path.join(outerWork, 'wip-dirty.txt'), 'dirty wip\n', 'utf8');
    await gitSuccess(outerWork, f.env, 'add', 'inner');
    await gitSuccess(outerWork, f.env, 'commit', '-m', 'outer bumps inner');

    const result = await pushPendingSubmodules(f.superWork, {
      mode: 'autoWhenNotConfigured',
      env: f.env,
    });

    assert.equal(hasFailures(result), false);
    assert.equal(result.skippedBecauseConfigured, false);
    assert.deepEqual(result.pushedSubmodules, ['outer/inner', 'outer']);
    assert.deepEqual(result.skippedDetachedSubmodules, ['vendor']);
    assert.equal(
      await gitSuccess(innerWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.innerBare, f.env, 'rev-parse', 'main'),
    );
    assert.equal(
      await gitSuccess(outerWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.outerBare, f.env, 'rev-parse', 'main'),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('autoWhenNotConfigured skips when push.recurseSubmodules is enabled and explicit push still pushes both', async () => {
  const f = await createNestedFixture();
  try {
    await enableGlobalRecurseSubmodules(f.superWork, f.env);
    assert.equal(await getEffectivePushRecurseSubmodules(f.superWork, f.env), 'on-demand');

    const outerWork = path.join(f.superWork, 'outer');
    fs.writeFileSync(path.join(outerWork, 'outer.txt'), 'outer v2\n', 'utf8');
    await gitSuccess(outerWork, f.env, 'commit', '-am', 'outer v2');

    const autoSkipped = await pushPendingSubmodules(f.superWork, {
      mode: 'autoWhenNotConfigured',
      env: f.env,
    });
    assert.equal(autoSkipped.skippedBecauseConfigured, true);
    assert.deepEqual(autoSkipped.pushedSubmodules, []);

    fs.writeFileSync(path.join(f.superWork, 'README.md'), 'super v2\n', 'utf8');
    await gitSuccess(f.superWork, f.env, 'commit', '-am', 'super v2');

    const explicit = await pushSubmodulesAndRepo(f.superWork, { env: f.env });
    assert.equal(hasFailures(explicit), false);
    assert.deepEqual(explicit.pushedSubmodules, ['outer']);
    assert.equal(
      await gitSuccess(outerWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.outerBare, f.env, 'rev-parse', 'main'),
    );
    assert.equal(
      await gitSuccess(f.superWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.superBare, f.env, 'rev-parse', 'main'),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('installPrePushHook is idempotent and pushes nested submodules before native git push', async () => {
  const f = await createNestedFixture();
  try {
    const first = await installPrePushHook(f.superWork, f.env);
    assert.equal(first.updated, true);
    const firstContent = fs.readFileSync(first.hookFile, 'utf8');

    const second = await installPrePushHook(f.superWork, f.env);
    assert.equal(second.updated, false);
    assert.equal(fs.readFileSync(second.hookFile, 'utf8'), firstContent);

    const innerWork = path.join(f.superWork, 'outer/inner');
    fs.writeFileSync(path.join(innerWork, 'inner.txt'), 'inner via hook\n', 'utf8');
    await gitSuccess(innerWork, f.env, 'commit', '-am', 'inner via hook');

    const outerWork = path.join(f.superWork, 'outer');
    await gitSuccess(outerWork, f.env, 'add', 'inner');
    await gitSuccess(outerWork, f.env, 'commit', '-m', 'outer via hook');

    fs.writeFileSync(path.join(f.superWork, 'README.md'), 'super via hook\n', 'utf8');
    await gitSuccess(f.superWork, f.env, 'commit', '-am', 'super via hook');

    await gitSuccess(f.superWork, f.env, 'push');

    assert.equal(
      await gitSuccess(innerWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.innerBare, f.env, 'rev-parse', 'main'),
    );
    assert.equal(
      await gitSuccess(outerWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.outerBare, f.env, 'rev-parse', 'main'),
    );
    assert.equal(
      await gitSuccess(f.superWork, f.env, 'rev-parse', 'HEAD'),
      await gitSuccess(f.superBare, f.env, 'rev-parse', 'main'),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('resolveTargetRepoRoot prefers workspace superproject when file is inside child submodule without .gitmodules', async () => {
  const f = await createNestedFixture();
  try {
    const vendorFile = path.join(f.superWork, 'vendor/vendor.txt');
    const innerFile = path.join(f.superWork, 'outer/inner/inner.txt');
    const outerWithNested = path.join(f.superWork, 'outer/outer.txt');

    assert.equal(
      resolveTargetRepoRoot([vendorFile], [f.superWork]),
      path.resolve(f.superWork),
    );
    assert.equal(
      resolveTargetRepoRoot([innerFile], [f.superWork]),
      path.resolve(f.superWork),
    );
    // outer itself declares .gitmodules (inner), so selecting outer targets outer directly
    assert.equal(
      resolveTargetRepoRoot([outerWithNested], [f.superWork]),
      path.resolve(path.join(f.superWork, 'outer')),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
