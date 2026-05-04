import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@temporalio/activity';
import type {
  CommandResult,
  DagEdge,
  HumanGapRequest,
  JudgeReport,
  NodeId,
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
  approveFollowupDagUpdate,
  approvePlanUpdate,
  cancelNodeUpdate,
  factoryRunWorkflow,
  getRunStateQuery,
  overrideGateUpdate,
  pauseRunUpdate,
  rejectPlanUpdate,
  requestFollowupDagUpdate,
  requestPlanChangesUpdate,
  resumeRunUpdate,
  retryFromStateUpdate,
  skipDelayUpdate,
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

test('temporal plan control updates are queryable and acknowledge decisions', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-control-'));
  const input = factoryInput('run-temporal-control-plan', artifactRoot);
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities(),
    taskQueuePrefix: 'durafoundry-temporal-control-plan',
  });

  try {
    await harness.runUntil(async () => {
      const rejectHandle = await startFactoryRun(harness, input, 'reject');
      const waitingState = await waitForPlanApproval(() => rejectHandle.query(getRunStateQuery));

      const paused = await rejectHandle.executeUpdate(pauseRunUpdate, {
        args: ['operator review'],
      });
      assert.equal(paused.status, 'paused');
      assert.equal(paused.paused, true);
      assert.equal(paused.plan?.planId, 'plan-1');
      assert.equal(paused.latestFailureReason, 'operator review');

      const pausedApproval = await rejectHandle.executeUpdate(approvePlanUpdate, {
        args: [approvalFor(waitingState, 'paused-approval')],
      });
      assert.equal(pausedApproval.accepted, false);
      assert.match(pausedApproval.rejectedReason ?? '', /not waiting/);

      const resumed = await rejectHandle.executeUpdate(resumeRunUpdate, {
        args: ['operator resume'],
      });
      assert.equal(resumed.status, 'waiting_for_plan_approval');
      assert.equal(resumed.paused, false);

      const rejected = await rejectHandle.executeUpdate(rejectPlanUpdate, {
        args: [approvalFor(waitingState, 'operator reject')],
      });
      assert.equal(rejected.accepted, true);
      assert.equal(rejected.status, 'plan_rejected');
      assert.equal((await rejectHandle.result()).status, 'plan_rejected');

      const changeHandle = await startFactoryRun(harness, input, 'changes');
      const changeWaitingState = await waitForPlanApproval(() =>
        changeHandle.query(getRunStateQuery),
      );
      const changes = await changeHandle.executeUpdate(requestPlanChangesUpdate, {
        args: [approvalFor(changeWaitingState, 'operator changes')],
      });
      assert.equal(changes.accepted, true);
      assert.equal(changes.status, 'changes_requested');
      assert.equal((await changeHandle.result()).status, 'changes_requested');
    });
  } finally {
    await harness.teardown();
  }
});

test('temporal execution controls pause scheduling and expose human follow-up state', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-human-control-'));
  const input = factoryInput('run-temporal-human-control', artifactRoot);
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities({
      delayWorktreeMs: 500,
      nodeIds: ['node-1', 'node-2'],
      edges: [{ from: 'node-1', to: 'node-2', reason: 'node-2 depends on node-1' }],
      maxActiveNodes: 1,
    }),
    taskQueuePrefix: 'durafoundry-temporal-human-control',
  });

  try {
    await harness.runUntil(async () => {
      const handle = await startFactoryRun(harness, input, 'human-control');
      const waitingState = await waitForPlanApproval(() => handle.query(getRunStateQuery));
      const approval = await handle.executeUpdate(approvePlanUpdate, {
        args: [approvalFor(waitingState, 'operator approve')],
      });
      assert.equal(approval.accepted, true);

      const paused = await handle.executeUpdate(pauseRunUpdate, {
        args: ['pause before launching more nodes'],
      });
      assert.equal(paused.status, 'paused');
      assert.equal(paused.paused, true);

      await new Promise((resolve) => setTimeout(resolve, 800));
      const pausedQuery = await handle.query(getRunStateQuery);
      assert.equal(pausedQuery.status, 'paused');
      assert.equal(pausedQuery.nodes['node-2']?.status, 'ready');

      const cancelled = await handle.executeUpdate(cancelNodeUpdate, {
        args: [{ nodeId: 'node-2', reason: 'bad discovery' }],
      });
      assert.equal(cancelled.nodes['node-2']?.status, 'cancelled');

      const overridden = await handle.executeUpdate(overrideGateUpdate, {
        args: [{ targetId: 'node-1-review', reason: 'operator accepted fixture risk' }],
      });
      assert.match(overridden.latestFailureReason ?? '', /Gate override/);

      const followup = await handle.executeUpdate(requestFollowupDagUpdate, {
        args: [humanGapRequest()],
      });
      assert.equal(followup.accepted, true);
      assert.equal(followup.pendingApproval, true);
      assert.equal(followup.runPaused, true);

      const followupQuery = await handle.query(getRunStateQuery);
      assert.equal(followupQuery.paused, true);
      assert.equal(followupQuery.requestedFollowup?.requestId, 'gap-request-1');
      assert.equal(followupQuery.followupDag?.status, 'waiting_for_approval');
      assert.equal(followupQuery.followupDag?.requiresApproval, true);

      const staleFollowupApproval = await handle.executeUpdate(approveFollowupDagUpdate, {
        args: [
          {
            planId: 'stale-followup',
            artifactUri: followupQuery.followupDag?.artifactUri ?? '',
            artifactSha256: followupQuery.followupDag?.artifactSha256,
            actor: 'operator',
          },
        ],
      });
      assert.equal(staleFollowupApproval.accepted, false);

      const followupApproval = await handle.executeUpdate(approveFollowupDagUpdate, {
        args: [
          {
            planId: followupQuery.followupDag?.planId ?? '',
            artifactUri: followupQuery.followupDag?.artifactUri ?? '',
            artifactSha256: followupQuery.followupDag?.artifactSha256,
            actor: 'operator',
          },
        ],
      });
      assert.equal(followupApproval.accepted, true);
      assert.equal((await handle.query(getRunStateQuery)).followupDag?.status, 'approved');

      const retry = await handle.executeUpdate(retryFromStateUpdate, {
        args: [
          {
            stateExecutionId: 'state-node-1',
            requestedBy: 'operator',
            reason: 'manual test',
          },
        ],
      });
      assert.equal(retry.accepted, false);
      assert.match(retry.rejectedReason ?? '', /not implemented/);

      const skip = await handle.executeUpdate(skipDelayUpdate, {
        args: [
          {
            delayId: 'delay-node-1',
            requestedBy: 'operator',
            reason: 'manual test',
            operatorMode: 'test',
          },
        ],
      });
      assert.equal(skip.accepted, false);
      assert.match(skip.rejectedReason ?? '', /not implemented/);

      const resumed = await handle.executeUpdate(resumeRunUpdate, {
        args: ['resume after follow-up approval'],
      });
      assert.equal(resumed.status, 'executing_dag');
      assert.equal(resumed.paused, false);

      const finalState = await handle.result();
      assert.equal(finalState.status, 'needs_human');
      assert.equal(finalState.nodes['node-1']?.status, 'merged');
      assert.equal(finalState.nodes['node-2']?.status, 'cancelled');
      assert.match(finalState.latestFailureReason ?? '', /no schedulable ready nodes/);
    });
  } finally {
    await harness.teardown();
  }
});

test('temporal cancellation after worktree creation schedules cleanup', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-cancel-cleanup-'));
  const input = factoryInput('run-temporal-cancel-cleanup', artifactRoot);
  const cleanupCalls: NodeId[] = [];
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities({
      cancellableCoderNodeId: 'node-1',
      cleanupCalls,
    }),
    taskQueuePrefix: 'durafoundry-temporal-cancel-cleanup',
  });

  try {
    await harness.runUntil(async () => {
      const handle = await startFactoryRun(harness, input, 'cancel-cleanup');
      const waitingState = await waitForPlanApproval(() => handle.query(getRunStateQuery));
      await handle.executeUpdate(approvePlanUpdate, {
        args: [approvalFor(waitingState, 'operator approve')],
      });
      const runningState = await waitForNodeStatus(
        () => handle.query(getRunStateQuery),
        'node-1',
        'running',
      );
      assert.equal(runningState.nodes['node-1']?.status, 'running');

      await handle.cancel();
      const finalState = await handle.result();
      assert.equal(finalState.status, 'needs_human');
      assert.equal(finalState.nodes['node-1']?.status, 'needs_human');
      assert.match(finalState.latestFailureReason ?? '', /cancel/i);
      assert.deepEqual(cleanupCalls, ['node-1']);
    });
  } finally {
    await harness.teardown();
  }
});

test('temporal merge failure is queryable and does not complete the run', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-failure-'));
  const input = factoryInput('run-temporal-failure', artifactRoot);
  const mergeCleanupCalls: NodeId[] = [];
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities({
      mergeFailureNodeId: 'node-1',
      cleanupCalls: mergeCleanupCalls,
    }),
    taskQueuePrefix: 'durafoundry-temporal-merge-failure',
  });

  try {
    await harness.runUntil(async () => {
      const mergeHandle = await startFactoryRun(harness, input, 'merge-failure');
      const waitingState = await waitForPlanApproval(() => mergeHandle.query(getRunStateQuery));
      await mergeHandle.executeUpdate(approvePlanUpdate, {
        args: [approvalFor(waitingState, 'operator approve')],
      });
      const mergeFailure = await mergeHandle.result();
      assert.equal(mergeFailure.status, 'needs_human');
      assert.match(mergeFailure.latestFailureReason ?? '', /Merge failed for node node-1/);
      assert.deepEqual(mergeCleanupCalls, ['node-1']);
    });
  } finally {
    await harness.teardown();
  }
});

test('temporal cleanup failure is queryable and does not complete the run', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-temporal-cleanup-failure-'));
  const input = factoryInput('run-temporal-cleanup-failure', artifactRoot);
  const cleanupCalls: NodeId[] = [];
  const harness = await createTemporalWorkerClientHarness({
    activities: temporalSmokeActivities({
      cleanupFailureNodeId: 'node-1',
      cleanupCalls,
    }),
    taskQueuePrefix: 'durafoundry-temporal-cleanup-failure',
  });

  try {
    await harness.runUntil(async () => {
      const handle = await startFactoryRun(harness, input, 'cleanup-failure');
      const waitingState = await waitForPlanApproval(() => handle.query(getRunStateQuery));
      await handle.executeUpdate(approvePlanUpdate, {
        args: [approvalFor(waitingState, 'operator approve')],
      });
      const cleanupFailure = await handle.result();
      assert.equal(cleanupFailure.status, 'needs_human');
      assert.match(cleanupFailure.latestFailureReason ?? '', /Cleanup failed after merging node node-1/);
      assert.deepEqual(cleanupCalls, ['node-1']);
      assert.match((await handle.query(getRunStateQuery)).latestFailureReason ?? '', /cleanup failed/i);
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

async function waitForNodeStatus(
  queryState: () => Promise<FactoryRunState>,
  nodeId: NodeId,
  status: NonNullable<FactoryRunState['nodes'][NodeId]>['status'],
) {
  const deadline = Date.now() + 10_000;
  let latestState = await queryState();
  while (latestState.nodes[nodeId]?.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latestState = await queryState();
  }
  return latestState;
}

function temporalSmokeActivities(
  options: {
    delayWorktreeMs?: number;
    nodeIds?: NodeId[];
    edges?: DagEdge[];
    maxActiveNodes?: number;
    cancellableCoderNodeId?: NodeId;
    mergeFailureNodeId?: NodeId;
    cleanupFailureNodeId?: NodeId;
    cleanupCalls?: NodeId[];
  } = {},
): FactoryRunActivities & DagExecutionActivities {
  return {
    async createDraftPlan() {
      const nodeIds = options.nodeIds ?? ['node-1'];
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
            nodeIds,
            reviewPolicy: {
              runBroadReview: true,
              runBroadJudge: true,
              autoPlanGaps: true,
              requireApprovalForGapWork: 'high-risk-only' as const,
            },
            acceptanceCriteria: ['Mock milestone passes.'],
          },
        ],
        nodes: nodeIds.map((nodeId) => ({
          id: nodeId,
          milestoneId: 'milestone-1',
          title: nodeId,
          kind: 'code' as const,
          bodyUri: `file:///${nodeId}.md`,
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
        })),
        edges: options.edges ?? [],
        globalAcceptanceCriteria: ['Mock plan completes.'],
        parallelism: {
          maxActiveNodes: options.maxActiveNodes ?? 1,
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
          nodeBodies: Object.fromEntries(
            nodeIds.map((nodeId) => [
              nodeId,
              {
                uri: `file:///${nodeId}.md`,
                sha256: 'node-body-sha',
                kind: 'node-body' as const,
              },
            ]),
          ),
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
      if (options.cancellableCoderNodeId === request.nodeId) {
        const context = Context.current();
        for (;;) {
          context.heartbeat({ nodeId: request.nodeId });
          await context.sleep(100);
        }
      }
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
      const nodeId = nodeIdFromBranch(input.branchName);
      if (options.mergeFailureNodeId === nodeId) {
        throw new Error(`simulated merge failure for ${nodeId}`);
      }
      return {
        repoPath: input.repoPath,
        trunkBranch: input.trunkBranch,
        branchName: input.branchName,
        mergedCommitSha: input.expectedCommitSha ?? 'commit-sha',
        trunkHeadBefore: 'before',
        trunkHeadAfter: `merge-${nodeId}`,
        commandsRun: [commandResult('git merge')],
      };
    },
    async cleanupNodeWorktree(input) {
      const nodeId = input.nodeId ?? nodeIdFromBranch(input.branchName ?? 'branch');
      options.cleanupCalls?.push(nodeId);
      if (options.cleanupFailureNodeId === nodeId) {
        throw new Error(`simulated cleanup failure for ${nodeId}`);
      }
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

function nodeIdFromBranch(branchName: string): NodeId {
  return branchName.split('/').at(-1) ?? branchName;
}

function factoryInput(runId: string, artifactRoot: string): FactoryRunInput {
  return {
    runId,
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
}

async function startFactoryRun(
  harness: Awaited<ReturnType<typeof createTemporalWorkerClientHarness>>,
  input: FactoryRunInput,
  suffix: string,
) {
  return harness.env.client.workflow.start(factoryRunWorkflow, {
    args: [input],
    taskQueue: harness.taskQueue,
    workflowId: `${input.runId}-${suffix}-${Date.now()}`,
  });
}

function approvalFor(state: FactoryRunState, actor: string) {
  return {
    planId: state.plan?.planId ?? '',
    artifactUri: state.plan?.artifactUri ?? '',
    artifactSha256: state.plan?.artifactSha256,
    actor,
  };
}

function humanGapRequest(): HumanGapRequest {
  return {
    requestId: 'gap-request-1',
    actor: 'operator',
    reason: 'bad discovery',
    pauseScheduling: true,
    requiresApprovalOverride: true,
    gapReport: {
      gapReportId: 'gap-report-1',
      source: 'human_intervention',
      summary: 'A bad discovery needs follow-up work.',
      recommendedPlan: 'repair_dag',
      gaps: [
        {
          id: 'gap-1',
          severity: 'high',
          category: 'quality-gap',
          description: 'The run needs operator-directed follow-up.',
          affectedRequirements: ['REQ-1'],
          suggestedTasks: ['Add the missing follow-up handling.'],
          blocking: true,
        },
      ],
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
