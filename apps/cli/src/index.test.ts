import { execFile, execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { FactoryRunState } from '@durafoundry/workflows';

import { runCli, runCliWithOptions, type CliRunOutput } from './index.js';

const execFileAsync = promisify(execFile);

test('temporal fixture acceptance run proves repair, serial merge, gates, artifacts, query, and JSON output', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-cli-acceptance-'));
  const env = await createTemporalEnv();
  const stateSamples: FactoryRunState[] = [];
  const reviewEvents: Array<{ nodeId: string; attemptNumber: number; status: string }> = [];
  const mergeEvents: string[] = [];
  const cleanupEvents: string[] = [];
  const broadReviewEvents: string[] = [];
  const broadJudgeEvents: string[] = [];
  let activeMerges = 0;
  let maxActiveMerges = 0;

  try {
    const output = await runCliWithOptions(
      [
        'run',
        '--spec',
        join(repoRoot, 'docs', 'SPEC.md'),
        '--fixture-repo',
        '--artifact-root',
        artifactRoot,
        '--temporal-address',
        env.address,
        '--task-queue',
        `durafoundry-cli-acceptance-${Date.now()}`,
        '--start-worker',
        '--auto-approve',
        '--preserve-fixture',
      ],
      {
        fixtureActivities: {
          failFirstReviewAttempt: true,
          observer: {
            onReviewResult(input, result) {
              reviewEvents.push({
                nodeId: input.nodeId,
                attemptNumber: input.attemptNumber,
                status: result.report.status,
              });
            },
            onMergeNodeCommitStart(input) {
              activeMerges += 1;
              maxActiveMerges = Math.max(maxActiveMerges, activeMerges);
              mergeEvents.push(nodeIdFromBranch(input.branchName));
            },
            onMergeNodeCommit() {
              activeMerges -= 1;
            },
            onCleanupNodeWorktree(input) {
              cleanupEvents.push(input.nodeId ?? nodeIdFromBranch(input.branchName ?? ''));
            },
            onBroadReviewResult(input, result) {
              broadReviewEvents.push(`${input.milestoneId}:${result.report.status}`);
            },
            onBroadJudgeResult(input, result) {
              broadJudgeEvents.push(`${input.milestoneId}:${result.report.status}`);
            },
          },
        },
        onStateSample(state) {
          stateSamples.push(structuredClone(state));
        },
      },
    );

    assert.equal(output.finalStatus, 'completed');
    assert.deepEqual(structuredClone(output), output);
    assert.equal(output.temporalAddress, env.address);
    assert.equal(output.artifactRoot, artifactRoot);
    assert.equal(output.fixtureRepoPath.startsWith(repoRoot), false);
    assert.equal(output.fixtureRepoPath.includes(`${artifactRoot}/fixtures/`), true);
    assert.deepEqual(Object.keys(output.nodeCommits).sort(), ['fixture-alpha', 'fixture-beta']);
    assert.deepEqual(Object.keys(output.mergeCommits).sort(), ['fixture-alpha', 'fixture-beta']);

    assert.ok(
      stateSamples.some((state) => state.status === 'waiting_for_plan_approval'),
      'expected a query sample while waiting for plan approval',
    );
    assert.ok(
      stateSamples.some(
        (state) => state.status === 'executing_dag' || Object.keys(state.nodes).length > 0,
      ),
      'expected a query sample after DAG execution started',
    );

    assert.deepEqual(
      reviewEvents.filter((event) => event.status === 'fail').map((event) => event.nodeId).sort(),
      ['fixture-alpha', 'fixture-beta'],
    );
    assert.deepEqual(
      reviewEvents.filter((event) => event.status === 'pass').map((event) => event.nodeId).sort(),
      ['fixture-alpha', 'fixture-beta'],
    );
    assert.ok(reviewEvents.some((event) => event.nodeId === 'fixture-alpha' && event.attemptNumber === 2));
    assert.ok(reviewEvents.some((event) => event.nodeId === 'fixture-beta' && event.attemptNumber === 2));

    assert.equal(maxActiveMerges, 1);
    assert.deepEqual(mergeEvents.sort(), ['fixture-alpha', 'fixture-beta']);
    assert.deepEqual(cleanupEvents.sort(), ['fixture-alpha', 'fixture-beta']);
    assert.deepEqual(broadReviewEvents, ['fixture-milestone:pass']);
    assert.deepEqual(broadJudgeEvents, ['fixture-milestone:pass']);

    await assertCommitExists(output.fixtureRepoPath, output.nodeCommits['fixture-alpha'] ?? '');
    await assertCommitExists(output.fixtureRepoPath, output.nodeCommits['fixture-beta'] ?? '');
    await assertCommitExists(output.fixtureRepoPath, output.mergeCommits['fixture-alpha'] ?? '');
    await assertCommitExists(output.fixtureRepoPath, output.mergeCommits['fixture-beta'] ?? '');
    assert.equal(
      await readFile(join(output.fixtureRepoPath, 'src', 'alpha.txt'), 'utf8'),
      'fixture-alpha: repaired\n',
    );
    assert.equal(
      await readFile(join(output.fixtureRepoPath, 'src', 'beta.txt'), 'utf8'),
      'fixture-beta: repaired\n',
    );
    await assertMissing(join(artifactRoot, 'worktrees', output.runId, 'fixture-alpha'));
    await assertMissing(join(artifactRoot, 'worktrees', output.runId, 'fixture-beta'));

    const plan = parseJson<{ nodes: unknown[]; milestones: unknown[] }>(
      await readFile(join(artifactRoot, 'plans', 'fixture-plan', 'plan.json'), 'utf8'),
      'plan artifact',
    );
    assert.equal(plan.nodes.length, 2);
    assert.equal(plan.milestones.length, 1);
    assert.match(
      await readFile(join(artifactRoot, 'plans', 'fixture-plan', 'nodes', 'fixture-alpha.md'), 'utf8'),
      /Update `src\/alpha\.txt`/,
    );
    assert.match(
      await readFile(
        join(artifactRoot, 'plans', 'fixture-plan', 'snapshots', 'fixture-snapshot.json'),
        'utf8',
      ),
      /"snapshotId": "fixture-snapshot"/,
    );
    assert.equal(
      parseJson<{ repaired: boolean }>(
        await readFile(
          join(artifactRoot, 'fake-agent', 'fixture-alpha-attempt-2', 'session.json'),
          'utf8',
        ),
        'fake agent session artifact',
      ).repaired,
      true,
    );
    assert.match(
      await readFile(join(artifactRoot, 'fake-agent', 'fixture-alpha-attempt-2', 'diff.patch'), 'utf8'),
      /fixture-alpha: repaired/,
    );
  } finally {
    await env.teardown();
  }
});

test('CLI run starts a Temporal worker, auto-approves through update, and prints JSON', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-cli-'));
  const env = await createTemporalEnv();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      join(repoRoot, 'apps', 'cli', 'dist', 'index.js'),
      'run',
      '--spec',
      join(repoRoot, 'docs', 'SPEC.md'),
      '--fixture-repo',
      '--artifact-root',
      artifactRoot,
      '--temporal-address',
      env.address,
      '--task-queue',
      `durafoundry-cli-${Date.now()}`,
      '--start-worker',
      '--auto-approve',
      '--preserve-fixture',
    ]);

    const output = parseCliOutput(stdout);
    assert.equal(output.finalStatus, 'completed');
    assert.match(output.runId, /^run-/);
    assert.equal(output.temporalRunId.length > 0, true);
    assert.match(output.workflowId, /^factory:/);
    assert.equal(output.temporalAddress, env.address);
    assert.match(output.taskQueue, /^durafoundry-cli-/);
    assert.equal(output.artifactRoot, artifactRoot);
    assert.equal(output.fixtureRepoPath.startsWith(repoRoot), false);
    assert.equal(output.fixtureRepoPath.includes(`${artifactRoot}/fixtures/`), true);
    assert.equal(Object.keys(output.nodeCommits).length, 2);
    assert.equal(Object.keys(output.mergeCommits).length, 2);
    assert.equal(Object.values(output.nodeCommits).every((sha) => sha.length > 0), true);
    assert.equal(Object.values(output.mergeCommits).every((sha) => sha.length > 0), true);
    assert.equal(output.planId.length > 0, true);
    assert.equal(output.dagId.length > 0, true);
    assert.equal(output.snapshotId.length > 0, true);
  } finally {
    await env.teardown();
  }
});

test('CLI rejects missing fixture repository flag before connecting to Temporal', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-cli-missing-fixture-'));

  await assert.rejects(
    runCli([
      'run',
      '--spec',
      join(repoRoot, 'docs', 'SPEC.md'),
      '--artifact-root',
      artifactRoot,
      '--start-worker',
      '--auto-approve',
    ]),
    /requires --fixture-repo/,
  );
});

test('CLI rejects unknown flags', async () => {
  const repoRoot = repoRootFromDist();

  await assert.rejects(
    runCli([
      'run',
      '--spec',
      join(repoRoot, 'docs', 'SPEC.md'),
      '--artifact-root',
      '.durafoundry',
      '--fixture-repo',
      '--auto-approve',
      '--bogus',
    ]),
    /Unknown argument: --bogus/,
  );
});

test('CLI fails clearly when Temporal is unavailable', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-cli-no-temporal-'));

  await assert.rejects(
    runCli([
      'run',
      '--spec',
      join(repoRoot, 'docs', 'SPEC.md'),
      '--artifact-root',
      artifactRoot,
      '--fixture-repo',
      '--temporal-address',
      '127.0.0.1:1',
      '--start-worker',
      '--auto-approve',
    ]),
    /Unable to connect to Temporal at 127\.0\.0\.1:1/,
  );
});

function parseCliOutput(stdout: string): CliRunOutput {
  const lastLine = stdout.trim().split('\n').at(-1);
  return parseJson<CliRunOutput>(lastLine ?? '', `CLI output: ${stdout}`);
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new Error(`Invalid JSON in ${label}`, { cause });
  }
}

function repoRootFromDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

async function assertCommitExists(repoPath: string, commitSha: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'cat-file', '-e', `${commitSha}^{commit}`]);
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), /ENOENT/);
}

function nodeIdFromBranch(branchName: string): string {
  return branchName.split('/').at(-1) ?? branchName;
}

async function createTemporalEnv(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createLocal({
    server: {
      executable: {
        type: 'existing-path',
        path: resolveTemporalCliPath(),
      },
      ui: false,
      log: {
        format: 'pretty',
        level: 'warn',
      },
    },
  });
}

function resolveTemporalCliPath(): string {
  if (process.env.TEMPORAL_CLI_PATH) {
    return process.env.TEMPORAL_CLI_PATH;
  }
  return execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim();
}
