import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  CommandResult,
  JudgeReport,
  NodeAttemptResult,
  ReviewReport,
} from '@durafoundry/domain';
import type {
  DagExecutionActivities,
  FactoryRunActivities,
  FactoryRunInput,
  FactoryRunState,
} from './contracts.js';
import { createTemporalWorkerClientHarness } from './temporal-test-harness.js';
import {
  approvePlanUpdate,
  factoryRunWorkflow,
  getRunStateQuery,
} from './workflows.js';

test('temporal worker/client smoke starts workflow, queries state, sends update, and awaits result', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-smoke-'));
  const input: FactoryRunInput = {
    runId: 'run-temporal-smoke',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot,
    runtime: {
      repoPath: '/tmp/fixture-repo',
      trunkBranch: 'main',
      worktreeRoot: join(artifactRoot, 'worktrees'),
      gitAuthor: {
        name: 'DuraFoundry',
        email: 'durafoundry@example.invalid',
      },
    },
  };
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities({ delayWorktreeMs: 500 }),
    taskQueuePrefix: 'durafoundry-temporal-smoke',
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
      assert.equal(waitingState.plan?.planId, 'plan-1');
      assert.equal(Object.keys(waitingState.nodes).length, 1);

      const staleApproval = await handle.executeUpdate(approvePlanUpdate, {
        args: [
          {
            planId: 'stale-plan',
            artifactUri: waitingState.plan?.artifactUri ?? '',
            artifactSha256: waitingState.plan?.artifactSha256,
            actor: 'temporal-test',
          },
        ],
      });
      assert.equal(staleApproval.accepted, false);
      assert.match(staleApproval.rejectedReason ?? '', /does not match/);
      assert.equal((await handle.query(getRunStateQuery)).status, 'waiting_for_plan_approval');

      const approval = await handle.executeUpdate(approvePlanUpdate, {
        args: [
          {
            planId: waitingState.plan?.planId ?? '',
            artifactUri: waitingState.plan?.artifactUri ?? '',
            artifactSha256: waitingState.plan?.artifactSha256,
            actor: 'temporal-test',
          },
        ],
      });
      assert.equal(approval.accepted, true);
      assert.equal(approval.status, 'executing_dag');

      const executingState = await waitForStatus(
        () => handle.query(getRunStateQuery),
        'executing_dag',
      );
      assert.equal(executingState.nodes['node-1']?.status, 'ready');

      const finalState = await handle.result();
      assert.equal(finalState.status, 'completed');
      assert.equal(finalState.approvedSnapshot?.snapshotId, 'snapshot-1');
      assert.equal(finalState.approvedSnapshot?.approvedBy, 'temporal-test');
      assert.equal(finalState.nodes['node-1']?.status, 'merged');
      assert.equal(finalState.nodeRuns?.['node-1']?.history.finalGatedCommitSha, 'commit-node-1');

      const completedQueryState = await handle.query(getRunStateQuery);
      assert.equal(completedQueryState.status, 'completed');
      assert.equal(completedQueryState.nodes['node-1']?.status, 'merged');
    });
  } finally {
    await harness.teardown();
  }
});

async function waitForPlanApproval(
  queryState: () => Promise<FactoryRunState>,
) {
  const deadline = Date.now() + 10_000;
  let latestState = await queryState();
  while (latestState.status !== 'waiting_for_plan_approval' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latestState = await queryState();
  }
  return latestState;
}

async function waitForStatus(
  queryState: () => Promise<FactoryRunState>,
  status: FactoryRunState['status'],
) {
  const deadline = Date.now() + 10_000;
  let latestState = await queryState();
  while (latestState.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latestState = await queryState();
  }
  return latestState;
}

function temporalSmokeActivities(
  options: { delayWorktreeMs?: number } = {},
): FactoryRunActivities & DagExecutionActivities {
  return {
    async createDraftPlan() {
      const plan = {
        planId: 'plan-1',
        dagId: 'dag-1',
        specId: 'spec-1',
        specVersion: 'v1',
        createdAt: '2026-05-03T12:00:00.000Z',
        plannerModel: 'temporal-smoke',
        status: 'proposed' as const,
        artifactUri: 'file:///plan.json',
        summary: 'Temporal smoke plan',
        assumptions: [],
        milestones: [
          {
            id: 'milestone-1',
            title: 'Milestone 1',
            description: 'Mock milestone',
            nodeIds: ['node-1'],
            reviewPolicy: {
              runBroadReview: true,
              runBroadJudge: true,
              autoPlanGaps: true,
              requireApprovalForGapWork: 'high-risk-only' as const,
            },
            acceptanceCriteria: ['Mock milestone passes.'],
          },
        ],
        nodes: [
          {
            id: 'node-1',
            milestoneId: 'milestone-1',
            title: 'Node 1',
            kind: 'code' as const,
            bodyUri: 'file:///node-1.md',
            description: 'Mock node',
            requirements: ['Mock requirement'],
            specRequirementIds: ['REQ-1'],
            acceptanceCriteria: ['Mock acceptance'],
            verificationCommands: ['npm test'],
            reviewerFocus: ['Mock focus'],
            judgeRubric: ['Mock rubric'],
            riskLevel: 'low' as const,
            worktree: {
              mode: 'per-node' as const,
              baseRef: 'main',
              cleanup: 'after-merge' as const,
            },
            maxAttempts: 2,
          },
        ],
        edges: [],
        globalAcceptanceCriteria: ['Mock plan completes.'],
        parallelism: {
          maxActiveNodes: 1,
          maxActiveHighRiskNodes: 1,
          mergeConcurrency: 1 as const,
        },
        mergePolicy: {
          mode: 'direct-to-trunk' as const,
          trunkBranch: 'main',
          requireGreenVerification: true,
          rebaseBeforeMerge: true,
          squash: false,
        },
      };
      return {
        summary: 'Temporal smoke plan',
        planRef: {
          uri: 'file:///plan.json',
          kind: 'plan-json' as const,
          sha256: 'plan-sha',
          createdAt: '2026-05-03T12:00:00.000Z',
          producer: 'temporal-smoke-test',
        },
        snapshotManifest: {
          snapshotId: 'snapshot-1',
          planJson: {
            uri: 'file:///plan.json',
            sha256: 'plan-sha',
            kind: 'plan-json' as const,
          },
          nodeBodies: {
            'node-1': {
              uri: 'file:///node-1.md',
              sha256: 'node-body-sha',
              kind: 'node-body' as const,
            },
          },
          milestoneBodies: {
            'milestone-1': {
              uri: 'file:///milestone-1.md',
              sha256: 'milestone-body-sha',
              kind: 'milestone-body' as const,
            },
          },
          createdAt: '2026-05-03T12:00:00.000Z',
        },
        snapshotManifestRef: {
          uri: 'file:///snapshot-1.json',
          kind: 'plan-snapshot-manifest' as const,
          sha256: 'snapshot-sha',
          createdAt: '2026-05-03T12:00:00.000Z',
          producer: 'temporal-smoke-test',
        },
        plan,
      };
    },
    async createNodeWorktree(request) {
      if (options.delayWorktreeMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayWorktreeMs));
      }
      return {
        repoPath: request.repoPath,
        worktreePath: `/tmp/worktrees/${request.nodeId}`,
        branchName: `durafoundry/${request.runId}/${request.nodeId}`,
        baseRef: request.baseRef ?? request.trunkBranch,
        baseCommitSha: 'base-sha',
      };
    },
    async runCoder(request) {
      return fakeAttempt(request.nodeId, request.attemptId, request.planSnapshotId);
    },
    async runVerification(request) {
      return {
        result: {
          command: request.command,
          status: 'passed' as const,
          summary: 'Verification passed.',
        },
        repairInstructions: [],
      };
    },
    async commitNodeChanges(request) {
      return {
        worktreePath: request.worktreePath,
        branchName: `durafoundry/run-temporal-smoke/${request.nodeId}`,
        commitSha: `commit-${request.nodeId}`,
        changedFiles: [`src/${request.nodeId}.txt`],
        diffUri: `file:///diff-${request.nodeId}.patch`,
        commandsRun: [commandResult('git commit')],
      };
    },
    async runReviewer(request) {
      return {
        report: passReviewReport(request.nodeId),
        repairInstructions: [],
      };
    },
    async runJudge(request) {
      return {
        report: passJudgeReport(request.nodeId),
        repairInstructions: [],
      };
    },
    async mergeNodeCommit(input) {
      return {
        repoPath: input.repoPath,
        trunkBranch: input.trunkBranch,
        branchName: input.branchName,
        mergedCommitSha: input.expectedCommitSha ?? 'commit-sha',
        trunkHeadBefore: 'before',
        trunkHeadAfter: `merge-${input.branchName.split('/').at(-1) ?? 'node'}`,
        commandsRun: [commandResult('git merge')],
      };
    },
    async cleanupNodeWorktree(input) {
      return {
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        branchName: input.branchName ?? 'branch',
        removedWorktree: true,
        removedBranch: true,
        commandsRun: [commandResult('git worktree remove')],
      };
    },
    async runBroadReviewer(request) {
      return {
        report: {
          ...passReviewReport(request.milestoneId),
          milestoneId: request.milestoneId,
          nodeId: undefined,
          reviewerRole: 'broad_reviewer' as const,
        },
      };
    },
    async runBroadJudge(request) {
      return {
        report: {
          ...passJudgeReport(request.milestoneId),
          milestoneId: request.milestoneId,
          nodeId: undefined,
          judgeRole: 'broad_judge' as const,
        },
      };
    },
  };
}

function fakeAttempt(
  nodeId: string,
  attemptId: string,
  planSnapshotId: string,
): NodeAttemptResult {
  return {
    attemptId,
    nodeId,
    planSnapshotId,
    startedAt: '2026-05-03T12:00:00.000Z',
    completedAt: '2026-05-03T12:00:01.000Z',
    status: 'completed',
    summary: `Implemented ${nodeId}.`,
    changedFiles: [`src/${nodeId}.txt`],
    commandsRun: [commandResult('fake coder')],
    testResults: [],
    diffUri: `file:///fake-${attemptId}.patch`,
    checkpointCommits: [],
    agentSessionUri: `file:///session-${attemptId}.json`,
    knownLimitations: [],
    needsFollowup: false,
  };
}

function passReviewReport(id: string): ReviewReport {
  return {
    reportId: `review-${id}`,
    nodeId: id,
    reviewerRole: 'reviewer',
    status: 'pass',
    summary: 'Review passed.',
    findings: [],
    requiredFixes: [],
    recommendedFixes: [],
    evidenceUris: [],
  };
}

function passJudgeReport(id: string): JudgeReport {
  return {
    reportId: `judge-${id}`,
    nodeId: id,
    judgeRole: 'judge',
    status: 'pass',
    summary: 'Judge passed.',
    requirementResults: [],
    cutCornerFindings: [],
    requiredFixes: [],
    evidenceUris: [],
  };
}

function commandResult(command: string): CommandResult {
  return {
    command,
    cwd: '/tmp/repo',
    exitCode: 0,
    durationMs: 0,
  };
}
