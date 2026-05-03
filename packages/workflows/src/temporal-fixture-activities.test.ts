import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureRepository } from '@durafoundry/fixture-repo';

import type { FactoryRunInput, FactoryRunState } from './contracts.js';
import { createFixtureActivityMap } from './fixture-activities.js';
import { createTemporalWorkerClientHarness } from './temporal-test-harness.js';
import { approvePlanUpdate, factoryRunWorkflow, getRunStateQuery } from './workflows.js';

const execFileAsync = promisify(execFile);

test('temporal fixture activity map runs fake agents and real git activities', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-fixture-'));
  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'temporal-fixture-activities',
  });
  const input: FactoryRunInput = {
    runId: 'run-temporal-fixture',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot,
    runtime: {
      repoPath: fixture.repoPath,
      trunkBranch: fixture.trunkBranch,
      worktreeRoot: join(artifactRoot, 'worktrees'),
      gitAuthor: {
        name: 'DuraFoundry',
        email: 'durafoundry@example.invalid',
      },
    },
  };
  const harness = await createTemporalWorkerClientHarness({
    activities: createFixtureActivityMap({
      createdAt: '2026-05-03T12:00:00.000Z',
    }),
    taskQueuePrefix: 'durafoundry-temporal-fixture',
  });

  try {
    await harness.runUntil(async () => {
      const handle = await harness.env.client.workflow.start(factoryRunWorkflow, {
        args: [input],
        taskQueue: harness.taskQueue,
        workflowId: `${input.runId}-${Date.now()}`,
      });
      const waitingState = await waitForPlanApproval(() => handle.query(getRunStateQuery));

      assert.equal(waitingState.status, 'waiting_for_plan_approval');
      assert.equal(waitingState.plan?.planId, 'fixture-plan');
      assert.ok(fixture.repoPath.startsWith(artifactRoot));

      const approval = await handle.executeUpdate(approvePlanUpdate, {
        args: [
          {
            planId: waitingState.plan?.planId ?? '',
            artifactUri: waitingState.plan?.artifactUri ?? '',
            artifactSha256: waitingState.plan?.artifactSha256,
            actor: 'temporal-fixture-test',
          },
        ],
      });
      assert.equal(approval.accepted, true);

      const finalState = await handle.result();
      assert.equal(finalState.status, 'completed');
      assert.equal(finalState.nodes['fixture-alpha']?.status, 'merged');
      assert.equal(finalState.nodes['fixture-beta']?.status, 'merged');
      assert.equal(await readFile(fixture.files.alpha, 'utf8'), 'fixture-alpha: implemented\n');
      assert.equal(await readFile(fixture.files.beta, 'utf8'), 'fixture-beta: implemented\n');

      for (const nodeId of ['fixture-alpha', 'fixture-beta']) {
        const nodeRun = finalState.nodeRuns?.[nodeId];
        assert.ok(nodeRun, `missing node run for ${nodeId}`);
        assert.ok(nodeRun.history.finalGatedCommitSha, `missing node commit for ${nodeId}`);
        assert.ok(nodeRun.state.mergedCommitSha, `missing merge commit for ${nodeId}`);
        await assertCommitExists(fixture.repoPath, nodeRun.history.finalGatedCommitSha);
        await assertCommitExists(fixture.repoPath, nodeRun.state.mergedCommitSha);
        await assert.rejects(access(nodeRun.state.worktreePath ?? ''), /ENOENT/);
      }
    });
  } finally {
    await harness.teardown();
  }
});

async function waitForPlanApproval(queryState: () => Promise<FactoryRunState>) {
  const deadline = Date.now() + 10_000;
  let latestState = await queryState();
  while (latestState.status !== 'waiting_for_plan_approval' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latestState = await queryState();
  }
  return latestState;
}

async function assertCommitExists(repoPath: string, commitSha: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'cat-file', '-e', `${commitSha}^{commit}`]);
}
