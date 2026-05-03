import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FactoryRunActivities, FactoryRunInput } from './contracts.js';
import {
  approvePlanState,
  pauseRunState,
  requestFollowupDagState,
  requestPlanChangesState,
  rejectPlanState,
  resumeRunState,
  runFactoryRunScaffold,
} from './scaffold.js';

test('deterministic scaffold reaches waiting-for-plan-approval with mocked activities', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-workflows-'));
  const input: FactoryRunInput = {
    runId: 'run-1',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot,
  };

  const state = await runFactoryRunScaffold(input, mockedActivities(artifactRoot));

  assert.equal(state.status, 'waiting_for_plan_approval');
  assert.equal(state.plan?.planId, 'plan-1');
  assert.equal(Object.keys(state.nodes).length, 1);

  const approval = approvePlanState(state, {
    planId: state.plan?.planId ?? '',
    artifactUri: state.plan?.artifactUri ?? '',
    artifactSha256: state.plan?.artifactSha256,
    actor: 'test',
  });
  assert.equal(approval.accepted, true);
  assert.equal(approval.status, 'executing_dag');
  assert.equal(state.plan?.status, 'approved');
  assert.equal(state.approvedSnapshot?.snapshotId, 'snapshot-1');
  assert.equal(state.approvedSnapshot?.planArtifactUri, 'file:///plan.json');
  assert.throws(() => {
    Object.assign(state.approvedSnapshot ?? {}, { snapshotId: 'mutated-snapshot' });
  });
  assert.equal(state.approvedSnapshot?.snapshotId, 'snapshot-1');
});

test('deterministic scaffold rejects stale plan approval artifacts', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-workflows-'));
  const state = await runFactoryRunScaffold(
    {
      runId: 'run-stale',
      specUri: 'file:///spec.md',
      specSha256: 'spec-sha',
      artifactRoot,
    },
    mockedActivities(artifactRoot),
  );

  const stale = approvePlanState(state, {
    planId: 'plan-1',
    artifactUri: 'file:///old-plan.json',
    artifactSha256: 'old-sha',
    actor: 'test',
  });

  assert.equal(stale.accepted, false);
  assert.match(stale.rejectedReason ?? '', /does not match/);
  assert.equal(state.status, 'waiting_for_plan_approval');
  assert.equal(state.approvedSnapshot, undefined);

  const stalePlan = approvePlanState(state, {
    planId: 'old-plan',
    artifactUri: 'file:///plan.json',
    artifactSha256: 'plan-sha',
    actor: 'test',
  });

  assert.equal(stalePlan.accepted, false);
  assert.match(stalePlan.rejectedReason ?? '', /does not match/);
  assert.equal(state.status, 'waiting_for_plan_approval');
  assert.equal(state.approvedSnapshot, undefined);
});

test('deterministic scaffold supports reject and request plan changes', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-workflows-'));
  const rejectedState = await runFactoryRunScaffold(
    {
      runId: 'run-reject',
      specUri: 'file:///spec.md',
      specSha256: 'spec-sha',
      artifactRoot,
    },
    mockedActivities(artifactRoot),
  );
  const rejected = rejectPlanState(rejectedState, {
    planId: 'plan-1',
    artifactUri: 'file:///plan.json',
    artifactSha256: 'plan-sha',
    actor: 'test',
  });
  assert.equal(rejected.accepted, true);
  assert.equal(rejected.status, 'plan_rejected');

  const changeState = await runFactoryRunScaffold(
    {
      runId: 'run-changes',
      specUri: 'file:///spec.md',
      specSha256: 'spec-sha',
      artifactRoot,
    },
    mockedActivities(artifactRoot),
  );
  const changes = requestPlanChangesState(changeState, {
    planId: 'plan-1',
    artifactUri: 'file:///plan.json',
    artifactSha256: 'plan-sha',
    actor: 'test',
  });
  assert.equal(changes.accepted, true);
  assert.equal(changes.status, 'changes_requested');
});

test('deterministic scaffold rejects invalid draft plans before approval', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-workflows-'));

  await assert.rejects(
    () =>
      runFactoryRunScaffold(
        {
          runId: 'run-invalid',
          specUri: 'file:///spec.md',
          specSha256: 'spec-sha',
          artifactRoot,
        },
        mockedActivitiesWithOptions(artifactRoot, { invalidPlan: true }),
      ),
    /Draft plan validation failed/,
  );

  await assert.rejects(
    () =>
      runFactoryRunScaffold(
        {
          runId: 'run-invalid-snapshot',
          specUri: 'file:///spec.md',
          specSha256: 'spec-sha',
          artifactRoot,
        },
        mockedActivitiesWithOptions(artifactRoot, { invalidSnapshot: true }),
      ),
    /Draft plan snapshot validation failed/,
  );
});

test('deterministic scaffold exposes pause and follow-up request transitions', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-workflows-'));
  const state = await runFactoryRunScaffold(
    {
      runId: 'run-2',
      specUri: 'file:///spec.md',
      specSha256: 'spec-sha',
      artifactRoot,
    },
    mockedActivities(artifactRoot),
  );

  const paused = pauseRunState(state, 'operator pause');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.paused, true);
  assert.equal(paused.statusBeforePause, 'waiting_for_plan_approval');

  const resumed = resumeRunState(state);
  assert.equal(resumed.status, 'waiting_for_plan_approval');
  assert.equal(resumed.paused, false);

  const followup = requestFollowupDagState(state, {
    requestId: 'request-1',
    actor: 'test',
    reason: 'stop for gap',
    pauseScheduling: true,
    cancelNodeIds: ['node-1'],
    gapReport: {
      gapReportId: 'gap-1',
      source: 'human_intervention',
      summary: 'Human found a gap.',
      gaps: [],
      recommendedPlan: 'repair_dag',
    },
  });
  assert.equal(followup.accepted, true);
  assert.equal(followup.runPaused, true);
  assert.deepEqual(followup.cancelledNodeIds, ['node-1']);

  const approval = approvePlanState(state, {
    planId: state.plan?.planId ?? '',
    artifactUri: state.plan?.artifactUri ?? '',
    artifactSha256: state.plan?.artifactSha256,
    actor: 'test',
  });
  assert.equal(approval.accepted, false);
  assert.match(approval.rejectedReason ?? '', /not waiting/);
});

function mockedActivities(artifactRoot: string): FactoryRunActivities {
  return mockedActivitiesWithOptions(artifactRoot, {});
}

function mockedActivitiesWithOptions(
  artifactRoot: string,
  options: { invalidPlan?: boolean; invalidSnapshot?: boolean },
): FactoryRunActivities {
  return {
    async createDraftPlan() {
      const plan = {
        planId: 'plan-1',
        dagId: 'dag-1',
        specId: 'spec-1',
        specVersion: 'v1',
        createdAt: '2026-05-03T12:00:00.000Z',
        plannerModel: 'mock',
        status: 'proposed' as const,
        artifactUri: 'file:///plan.json',
        summary: 'Mocked plan',
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
            milestoneId: options.invalidPlan ? 'missing-milestone' : 'milestone-1',
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
        summary: 'Mocked plan',
        planRef: {
          uri: 'file:///plan.json',
          kind: 'plan-json',
          sha256: 'plan-sha',
          createdAt: '2026-05-03T12:00:00.000Z',
          producer: 'workflow-test',
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
              uri: options.invalidSnapshot ? 'file:///wrong-node-1.md' : 'file:///node-1.md',
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
          kind: 'plan-snapshot-manifest',
          sha256: 'snapshot-sha',
          createdAt: '2026-05-03T12:00:00.000Z',
          producer: 'workflow-test',
        },
        plan,
      };
    },
  };
}
