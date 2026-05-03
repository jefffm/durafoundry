import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  FactoryRunState,
  FollowupDagDraftResult,
} from './contracts.js';
import {
  approveFollowupDagState,
  requestFollowupDagState,
  resumeRunState,
} from './scaffold.js';
import type {
  HumanGapRequest,
  NodeId,
  PlanDAG,
  PlanSnapshotManifest,
  TaskNode,
} from '@durafoundry/domain';

test('followup request can pause scheduling without cancelling nodes', () => {
  const state = executableState();
  const result = requestFollowupDagState(state, gapRequest({ pauseScheduling: true }));

  assert.equal(result.accepted, true);
  assert.equal(result.runPaused, true);
  assert.equal(result.pendingApproval, false);
  assert.equal(state.paused, true);
  assert.equal(state.status, 'paused');
  assert.equal(state.statusBeforePause, 'executing_dag');
  assert.equal(state.nodes['node-a']?.status, 'running');
  assert.equal(state.nodes['node-b']?.status, 'ready');
});

test('followup request cancels and skips only explicitly selected unmerged nodes', () => {
  const mergedSummary = Object.freeze({
    nodeId: 'node-merged',
    status: 'merged' as const,
  });
  const state = executableState({
    nodes: {
      'node-a': { nodeId: 'node-a', status: 'running' },
      'node-b': { nodeId: 'node-b', status: 'ready' },
      'node-c': { nodeId: 'node-c', status: 'ready' },
      'node-active-unselected': { nodeId: 'node-active-unselected', status: 'running' },
      'node-merged': mergedSummary,
    },
  });

  const result = requestFollowupDagState(
    state,
    gapRequest({
      pauseScheduling: true,
      cancelNodeIds: ['node-a', 'node-merged'],
      markUnstartedNodeIdsSkipped: ['node-b'],
    }),
  );

  assert.deepEqual(result.cancelledNodeIds, ['node-a']);
  assert.equal(state.nodes['node-a']?.status, 'cancelled');
  assert.equal(state.nodes['node-b']?.status, 'skipped');
  assert.equal(state.nodes['node-c']?.status, 'ready');
  assert.equal(state.nodes['node-active-unselected']?.status, 'running');
  assert.equal(state.nodes['node-merged'], mergedSummary);
  assert.equal(Object.isFrozen(state.nodes['node-merged']), true);
});

test('followup DAG approval accepts a matching generated plan', () => {
  const state = executableState();
  const draft = followupDraft({ approvalPolicy: 'always' });
  const requested = requestFollowupDagState(
    state,
    gapRequest({ pauseScheduling: true }),
    draft,
  );

  assert.equal(requested.accepted, true);
  assert.equal(requested.followupDagId, 'followup-dag');
  assert.equal(requested.pendingApproval, true);
  assert.equal(state.followupDag?.status, 'waiting_for_approval');
  assert.equal(state.followupDag?.parentDagId, 'parent-dag');
  assert.equal(state.followupDag?.parentSnapshotId, 'parent-snapshot');

  const approved = approveFollowupDagState(state, {
    planId: 'followup-plan',
    artifactUri: 'file:///followup-plan.json',
    artifactSha256: 'followup-plan-sha',
    actor: 'test',
  });

  assert.equal(approved.accepted, true);
  assert.equal(state.followupDag?.status, 'approved');
});

test('high-risk followup DAG requires approval under high-risk-only policy', () => {
  const state = executableState();
  const result = requestFollowupDagState(
    state,
    gapRequest({ pauseScheduling: true }),
    followupDraft({ approvalPolicy: 'high-risk-only', riskLevel: 'high' }),
  );

  assert.equal(result.accepted, true);
  assert.equal(result.pendingApproval, true);
  assert.equal(state.followupDag?.requiresApproval, true);
  assert.deepEqual(state.followupDag?.highRiskNodeIds, ['followup-node']);
});

test('approved followup DAG can resume legal original scheduling', () => {
  const state = executableState();
  requestFollowupDagState(
    state,
    gapRequest({ pauseScheduling: true }),
    followupDraft({ approvalPolicy: 'never' }),
  );

  assert.equal(state.status, 'paused');
  assert.equal(state.followupDag?.status, 'approved');

  const resumed = resumeRunState(state);

  assert.equal(resumed.paused, false);
  assert.equal(resumed.status, 'executing_dag');
  assert.equal(resumed.statusBeforePause, undefined);
});

test('stale followup DAG approval is rejected', () => {
  const state = executableState();
  requestFollowupDagState(
    state,
    gapRequest({ pauseScheduling: true }),
    followupDraft({ approvalPolicy: 'always' }),
  );

  const approved = approveFollowupDagState(state, {
    planId: 'old-followup-plan',
    artifactUri: 'file:///followup-plan.json',
    artifactSha256: 'followup-plan-sha',
    actor: 'test',
  });

  assert.equal(approved.accepted, false);
  assert.match(approved.rejectedReason ?? '', /does not match/);
  assert.equal(state.followupDag?.status, 'waiting_for_approval');
});

function executableState(input: {
  nodes?: FactoryRunState['nodes'];
} = {}): FactoryRunState {
  return {
    runId: 'run-1',
    status: 'executing_dag',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot: '/tmp/artifacts',
    nodes:
      input.nodes ??
      {
        'node-a': { nodeId: 'node-a', status: 'running' },
        'node-b': { nodeId: 'node-b', status: 'ready' },
      },
    paused: false,
    approvedSnapshot: {
      snapshotId: 'parent-snapshot',
      planId: 'parent-plan',
      dagId: 'parent-dag',
      planArtifactUri: 'file:///parent-plan.json',
      planArtifactSha256: 'parent-plan-sha',
      manifestUri: 'file:///parent-snapshot.json',
      manifestSha256: 'parent-snapshot-sha',
      approvedBy: 'test',
    },
  };
}

function gapRequest(input: {
  pauseScheduling?: boolean;
  cancelNodeIds?: NodeId[];
  markUnstartedNodeIdsSkipped?: NodeId[];
} = {}): HumanGapRequest {
  return {
    requestId: 'gap-request-1',
    actor: 'test',
    reason: 'human found a gap',
    pauseScheduling: input.pauseScheduling ?? true,
    cancelNodeIds: input.cancelNodeIds,
    markUnstartedNodeIdsSkipped: input.markUnstartedNodeIdsSkipped,
    gapReport: {
      gapReportId: 'gap-1',
      source: 'human_intervention',
      summary: 'Human follow-up gap.',
      gaps: [
        {
          id: 'gap-finding-1',
          severity: 'high',
          category: 'quality-gap',
          description: 'Add follow-up work.',
          affectedRequirements: ['REQ-1'],
          suggestedTasks: ['Implement follow-up node.'],
          blocking: true,
        },
      ],
      recommendedPlan: 'repair_dag',
    },
  };
}

function followupDraft(input: {
  approvalPolicy: FollowupDagDraftResult['approvalPolicy'];
  riskLevel?: TaskNode['riskLevel'];
}): FollowupDagDraftResult {
  const plan = followupPlan(input.riskLevel ?? 'low');
  const snapshotManifest = manifestForPlan(plan);
  return {
    approvalPolicy: input.approvalPolicy,
    summary: plan.summary,
    plan,
    planRef: {
      uri: 'file:///followup-plan.json',
      kind: 'plan-json',
      sha256: 'followup-plan-sha',
      createdAt: '2026-05-03T12:00:00.000Z',
      producer: 'followup-test',
    },
    snapshotManifest,
    snapshotManifestRef: {
      uri: 'file:///followup-snapshot.json',
      kind: 'plan-snapshot-manifest',
      sha256: 'followup-snapshot-sha',
      createdAt: '2026-05-03T12:00:00.000Z',
      producer: 'followup-test',
    },
  };
}

function followupPlan(riskLevel: TaskNode['riskLevel']): PlanDAG {
  return {
    planId: 'followup-plan',
    dagId: 'followup-dag',
    parentDagId: 'parent-dag',
    parentSnapshotId: 'parent-snapshot',
    specId: 'spec-1',
    specVersion: 'v1',
    createdAt: '2026-05-03T12:00:00.000Z',
    plannerModel: 'test',
    status: 'proposed',
    artifactUri: 'file:///followup-plan.json',
    summary: 'Follow-up DAG',
    assumptions: [],
    milestones: [
      {
        id: 'followup-milestone',
        title: 'Follow-up milestone',
        description: 'Follow-up milestone.',
        nodeIds: ['followup-node'],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['Follow-up work completes.'],
      },
    ],
    nodes: [
      {
        id: 'followup-node',
        milestoneId: 'followup-milestone',
        title: 'Follow-up node',
        kind: 'code',
        bodyUri: 'file:///followup-node.md',
        description: 'Implement follow-up work.',
        requirements: ['Implement follow-up work.'],
        specRequirementIds: ['REQ-1'],
        acceptanceCriteria: ['Follow-up node passes.'],
        expectedFiles: ['src/followup.txt'],
        verificationCommands: ['npm test'],
        reviewerFocus: ['Review follow-up.'],
        judgeRubric: ['Judge follow-up.'],
        riskLevel,
        worktree: {
          mode: 'per-node',
          baseRef: 'main',
          cleanup: 'after-merge',
        },
        maxAttempts: 1,
      },
    ],
    edges: [],
    globalAcceptanceCriteria: ['Follow-up DAG completes.'],
    parallelism: {
      maxActiveNodes: 1,
      maxActiveHighRiskNodes: 1,
      mergeConcurrency: 1,
    },
    mergePolicy: {
      mode: 'direct-to-trunk',
      trunkBranch: 'main',
      requireGreenVerification: true,
      rebaseBeforeMerge: true,
      squash: false,
    },
  };
}

function manifestForPlan(plan: PlanDAG): PlanSnapshotManifest {
  return {
    snapshotId: 'followup-snapshot',
    planJson: {
      uri: 'file:///followup-plan.json',
      sha256: 'followup-plan-sha',
      kind: 'plan-json',
    },
    nodeBodies: {
      'followup-node': {
        uri: 'file:///followup-node.md',
        sha256: 'followup-node-sha',
        kind: 'node-body',
      },
    },
    milestoneBodies: {
      'followup-milestone': {
        uri: 'file:///followup-milestone.md',
        sha256: 'followup-milestone-sha',
        kind: 'milestone-body',
      },
    },
    createdAt: '2026-05-03T12:00:00.000Z',
  };
}
