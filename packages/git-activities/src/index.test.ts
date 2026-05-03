import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

import { createFixtureRepository } from '@durafoundry/fixture-repo';

import {
  cleanupNodeWorktree,
  commitNodeChanges,
  createNodeWorktree,
  GitActivityError,
  mergeNodeCommit,
  prepareRepository,
} from './index.js';

const execFileAsync = promisify(execFile);
const author = {
  name: 'DuraFoundry Test',
  email: 'test@durafoundry.local',
};

test('creates a factory worktree, commits node changes, merges to trunk, and cleans up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-git-activities-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'merge-flow',
  });

  const prepared = await prepareRepository({
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
  });
  assert.equal(prepared.clean, true);
  assert.equal(prepared.trunkBranch, 'main');

  const worktree = await createNodeWorktree({
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    worktreeRoot: join(root, 'worktrees'),
    runId: 'run-1',
    nodeId: 'node-alpha',
  });
  await access(worktree.worktreePath);
  await access(worktree.markerPath);
  assert.equal(await git(['branch', '--show-current'], worktree.worktreePath), worktree.branchName);

  await writeFile(join(worktree.worktreePath, 'src', 'alpha.txt'), 'alpha: changed by node\n');
  const commit = await commitNodeChanges({
    worktreePath: worktree.worktreePath,
    nodeId: 'node-alpha',
    message: 'Implement node alpha',
    author,
    artifactRoot: join(root, 'artifacts'),
    producer: 'git-activities-test',
  });

  assert.match(commit.commitSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(commit.changedFiles, ['src/alpha.txt']);
  assert.match(commit.diffUri ?? '', /^file:\/\//);
  assert.match(commit.diffUri ?? '', /\/git\/node-alpha\/[0-9a-f]{64}\.patch$/);

  const merge = await mergeNodeCommit({
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    branchName: worktree.branchName,
    expectedCommitSha: commit.commitSha,
    author,
  });

  assert.equal(merge.mergedCommitSha, commit.commitSha);
  assert.notEqual(merge.trunkHeadBefore, merge.trunkHeadAfter);
  assert.equal(await readFile(fixture.files.alpha, 'utf8'), 'alpha: changed by node\n');

  const cleanup = await cleanupNodeWorktree({
    repoPath: fixture.repoPath,
    worktreePath: worktree.worktreePath,
    runId: 'run-1',
    nodeId: 'node-alpha',
    branchName: worktree.branchName,
  });

  assert.equal(cleanup.removedWorktree, true);
  assert.equal(cleanup.removedBranch, true);
  await assert.rejects(() => access(worktree.worktreePath));
  await assert.rejects(() => access(worktree.markerPath));
  await assert.rejects(() => git(['rev-parse', '--verify', worktree.branchName], fixture.repoPath));
});

test('refuses a dirty trunk without mutating repository state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-dirty-trunk-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'dirty-trunk',
  });
  await writeFile(fixture.files.beta, 'beta: dirty\n');

  await assert.rejects(
    () =>
      prepareRepository({
        repoPath: fixture.repoPath,
        trunkBranch: fixture.trunkBranch,
      }),
    (error) => error instanceof GitActivityError && error.code === 'dirty_trunk',
  );

  assert.equal(await git(['status', '--porcelain'], fixture.repoPath), 'M src/beta.txt');
});

test('reports missing branches as structured non-destructive failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-missing-branch-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'missing-branch',
  });

  await assert.rejects(
    () =>
      prepareRepository({
        repoPath: fixture.repoPath,
        trunkBranch: 'missing-main',
      }),
    (error) => error instanceof GitActivityError && error.code === 'missing_branch',
  );

  assert.equal(await git(['branch', '--show-current'], fixture.repoPath), fixture.trunkBranch);
  assert.equal(await git(['status', '--porcelain'], fixture.repoPath), '');
});

test('cleanup refuses unmarked worktree paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-unmarked-cleanup-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'unmarked-cleanup',
  });
  const unmarkedPath = join(root, 'not-a-factory-worktree');

  await assert.rejects(
    () =>
      cleanupNodeWorktree({
        repoPath: fixture.repoPath,
        worktreePath: unmarkedPath,
        runId: 'run-1',
      }),
    (error) => error instanceof GitActivityError && error.code === 'not_factory_owned',
  );
});

test('cleanup refuses mismatched factory markers and leaves worktree intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-mismatch-cleanup-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'mismatch-cleanup',
  });
  const worktree = await createNodeWorktree({
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    worktreeRoot: join(root, 'worktrees'),
    runId: 'run-1',
    nodeId: 'node-alpha',
  });

  await assert.rejects(
    () =>
      cleanupNodeWorktree({
        repoPath: fixture.repoPath,
        worktreePath: worktree.worktreePath,
        runId: 'wrong-run',
      }),
    (error) => error instanceof GitActivityError && error.code === 'not_factory_owned',
  );

  await access(worktree.worktreePath);
  await access(worktree.markerPath);
});

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}
