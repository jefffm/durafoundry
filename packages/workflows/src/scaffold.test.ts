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
  assert.equal(approval.status, 'plan_approved');
  assert.equal(state.plan?.status, 'approved');
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
  return {
    async createDraftPlan() {
      return {
        summary: 'Mocked plan',
        planRef: {
          uri: 'file:///plan.json',
          kind: 'plan-json',
          sha256: 'plan-sha',
          createdAt: '2026-05-03T12:00:00.000Z',
          producer: 'workflow-test',
        },
        plan: {
          planId: 'plan-1',
          dagId: 'dag-1',
          specId: 'spec-1',
          specVersion: 'v1',
          createdAt: '2026-05-03T12:00:00.000Z',
          plannerModel: 'mock',
          status: 'proposed',
          artifactUri: `${artifactRoot}/plan.json`,
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
                requireApprovalForGapWork: 'high-risk-only',
              },
              acceptanceCriteria: ['Mock milestone passes.'],
            },
          ],
          nodes: [
            {
              id: 'node-1',
              milestoneId: 'milestone-1',
              title: 'Node 1',
              kind: 'code',
              bodyUri: 'file:///node-1.md',
              description: 'Mock node',
              requirements: ['Mock requirement'],
              specRequirementIds: ['REQ-1'],
              acceptanceCriteria: ['Mock acceptance'],
              verificationCommands: ['npm test'],
              reviewerFocus: ['Mock focus'],
              judgeRubric: ['Mock rubric'],
              riskLevel: 'low',
              worktree: {
                mode: 'per-node',
                baseRef: 'main',
                cleanup: 'after-merge',
              },
              maxAttempts: 2,
            },
          ],
          edges: [],
          globalAcceptanceCriteria: ['Mock plan completes.'],
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
        },
      };
    },
  };
}
