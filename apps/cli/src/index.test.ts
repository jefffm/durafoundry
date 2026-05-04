import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TestWorkflowEnvironment } from '@temporalio/testing';

import { runCli, type CliRunOutput } from './index.js';

const execFileAsync = promisify(execFile);

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
  try {
    return JSON.parse(lastLine ?? '') as CliRunOutput;
  } catch (cause) {
    throw new Error(`CLI did not print valid JSON: ${stdout}`, { cause });
  }
}

function repoRootFromDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
