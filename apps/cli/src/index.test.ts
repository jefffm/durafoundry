import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { CliRunOutput } from './index.js';

const execFileAsync = promisify(execFile);

test('CLI run uses a generated fixture repo and prints machine-readable JSON', async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-cli-'));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(repoRoot, 'apps', 'cli', 'dist', 'index.js'),
    'run',
    '--spec',
    join(repoRoot, 'docs', 'SPEC.md'),
    '--fixture-repo',
    '--artifact-root',
    artifactRoot,
  ]);

  assert.equal(stderr, '');
  const output = parseCliOutput(stdout);
  assert.equal(output.finalStatus, 'completed');
  assert.match(output.runId, /^run-/);
  assert.match(output.workflowId, /^factory:/);
  assert.equal(output.artifactRoot, artifactRoot);
  assert.equal(output.fixtureRepoPath.startsWith(repoRoot), false);
  assert.equal(output.fixtureRepoPath.includes(`${artifactRoot}/fixtures/`), true);
  assert.equal(Object.keys(output.nodeCommits).length, 2);
  assert.equal(Object.keys(output.mergeCommits).length, 2);
  assert.equal(Object.values(output.nodeCommits).every((sha) => sha.length > 0), true);
  assert.equal(Object.values(output.mergeCommits).every((sha) => sha.length > 0), true);
});

function parseCliOutput(stdout: string): CliRunOutput {
  try {
    return JSON.parse(stdout) as CliRunOutput;
  } catch (cause) {
    throw new Error(`CLI did not print valid JSON: ${stdout}`, { cause });
  }
}
