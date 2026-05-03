import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanupNodeWorktree,
  commitNodeChanges,
  createNodeWorktree,
  mergeNodeCommit,
} from '@durafoundry/git-activities';
import { createFixtureRepository } from '@durafoundry/fixture-repo';
import {
  runFakeBroadJudge,
  runFakeBroadReviewer,
  runFakeCoder,
  runFakeJudge,
  runFakePlanner,
  runFakeReviewer,
} from '@durafoundry/fake-agent-activities';
import {
  applyDraftPlan,
  approveFollowupDagState,
  approvePlanState,
  createInitialFactoryRunState,
  executeDagScaffold,
  requestFollowupDagState,
  resumeRunState,
  type DagExecutionActivities,
  type DraftPlanResult,
  type FactoryRunState,
  type FollowupDagDraftResult,
} from '@durafoundry/workflows';
import type { CliRunOutput } from './index.js';
import type {
  HumanGapRequest,
  NodeId,
  PlanDAG,
  PlanSnapshotManifest,
  TaskNode,
} from '@durafoundry/domain';

const execFileAsync = promisify(execFile);

test('v0 acceptance run repairs, merges, gates, cleans up, and writes artifacts', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-e2e-'));
  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'e2e-repair',
  });
  console.info(
    `e2e fixture ${JSON.stringify({ artifactRoot, fixtureRepoPath: fixture.repoPath })}`,
  );

  const planned = await runFakePlanner({
    artifactRoot,
    specId: 'spec-e2e',
    specVersion: 'v0',
    repoId: fixture.fixtureRepoId,
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    createdAt: '2026-05-03T12:00:00.000Z',
  });
  const draft: DraftPlanResult = {
    summary: planned.bundle.plan.summary,
    plan: planned.bundle.plan,
    planRef: planned.bundle.planRef,
    snapshotManifest: planned.snapshot.manifest,
    snapshotManifestRef: planned.snapshot.manifestRef,
  };
  const state = createInitialFactoryRunState({
    runId: 'run-e2e',
    specUri: pathToFileURL(join(repoRoot, 'docs', 'SPEC.md')).href,
    specSha256: 'spec-sha',
    artifactRoot,
  });
  state.status = 'planning';
  applyDraftPlan(state, draft);
  const approval = approvePlanState(state, {
    planId: draft.plan.planId,
    artifactUri: draft.planRef.uri,
    artifactSha256: draft.planRef.sha256,
    actor: 'acceptance-test',
  });

  assert.equal(approval.accepted, true);
  assert.equal(Object.isFrozen(state.approvedSnapshot), true);
  assert.equal(draft.planRef.sha256?.length, 64);
  assert.equal(draft.snapshotManifestRef.sha256?.length, 64);
  await assertArtifactReadable(draft.planRef.uri);
  await assertArtifactReadable(draft.snapshotManifestRef.uri);

  const mergeTracker = { active: 0, max: 0 };
  const result = await executeDagScaffold(
    state,
    {
      plan: draft.plan,
      repoPath: fixture.repoPath,
      worktreeRoot: join(artifactRoot, 'worktrees'),
      artifactRoot,
      gitAuthor: {
        name: 'DuraFoundry E2E',
        email: 'e2e@durafoundry.local',
      },
    },
    e2eActivities(mergeTracker),
  );

  const repairedAlpha = result.nodeResults['fixture-alpha'];
  assert.equal(result.state.status, 'completed');
  assert.equal(repairedAlpha?.history.attemptIds.length, 2);
  assert.equal(repairedAlpha?.history.repairInstructions[0]?.source, 'review');
  assert.equal(result.mergedNodes.length, 2);
  assert.equal(mergeTracker.max, 1);
  assert.equal(result.cleanupResults.length, 2);
  assert.equal(result.cleanupResults.every((cleanup) => cleanup.removedWorktree), true);
  assert.equal(result.milestoneResults[0]?.review?.status, 'pass');
  assert.equal(result.milestoneResults[0]?.judge?.status, 'pass');
  assert.equal((await readFile(fixture.files.alpha, 'utf8')).includes('repaired'), true);
  assert.equal((await readFile(fixture.files.beta, 'utf8')).includes('implemented'), true);
  assert.equal(fixture.repoPath.startsWith(repoRoot), false);

  for (const nodeResult of Object.values(result.nodeResults)) {
    for (const attempt of nodeResult.attempts) {
      await assertArtifactReadable(attempt.attempt.diffUri);
      await assertArtifactReadable(attempt.attempt.agentSessionUri);
    }
  }
});

test('v0 acceptance covers human follow-up request and resume', () => {
  const state = followupState();
  const requested = requestFollowupDagState(
    state,
    humanGapRequest(),
    followupDraft('high'),
  );

  assert.equal(requested.accepted, true);
  assert.equal(requested.pendingApproval, true);
  assert.equal(state.paused, true);
  assert.equal(state.nodes['node-a']?.status, 'cancelled');
  assert.equal(state.nodes['node-b']?.status, 'ready');

  const approved = approveFollowupDagState(state, {
    planId: 'followup-plan',
    artifactUri: 'file:///followup-plan.json',
    artifactSha256: 'followup-plan-sha',
    actor: 'acceptance-test',
  });
  assert.equal(approved.accepted, true);

  const resumed = resumeRunState(state);
  assert.equal(resumed.status, 'executing_dag');
  assert.equal(resumed.paused, false);
});

test('v0 acceptance covers CLI execution with generated fixture repository', async () => {
  const repoRoot = repoRootFromDist();
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-e2e-cli-'));
  const { stdout } = await execFileAsync(process.execPath, [
    join(repoRoot, 'apps', 'cli', 'dist', 'index.js'),
    'run',
    '--spec',
    join(repoRoot, 'docs', 'SPEC.md'),
    '--fixture-repo',
    '--artifact-root',
    artifactRoot,
  ]);
  const output = parseCliOutput(stdout);
  console.info(
    `e2e cli ${JSON.stringify({ artifactRoot, fixtureRepoPath: output.fixtureRepoPath })}`,
  );

  assert.equal(output.finalStatus, 'completed');
  assert.equal(output.fixtureRepoPath.startsWith(repoRoot), false);
  assert.equal(output.artifactRoot, artifactRoot);
  assert.equal(Object.keys(output.nodeCommits).length, 2);
  assert.equal(Object.keys(output.mergeCommits).length, 2);
});

function e2eActivities(mergeTracker: { active: number; max: number }): DagExecutionActivities {
  return {
    async createNodeWorktree(input) {
      return createNodeWorktree(input);
    },
    async runCoder(input) {
      return runFakeCoder(input);
    },
    async runVerification(input) {
      return {
        result: {
          command: input.command,
          status: 'passed',
          summary: 'E2E verification passed.',
        },
        repairInstructions: [],
      };
    },
    async commitNodeChanges(input) {
      return commitNodeChanges({
        ...input,
        producer: '@durafoundry/e2e',
      });
    },
    async runReviewer(input) {
      return runFakeReviewer({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: input.nodeId === 'fixture-alpha',
      });
    },
    async runJudge(input) {
      return runFakeJudge({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: false,
      });
    },
    async mergeNodeCommit(input) {
      mergeTracker.active += 1;
      mergeTracker.max = Math.max(mergeTracker.max, mergeTracker.active);
      try {
        return await mergeNodeCommit(input);
      } finally {
        mergeTracker.active -= 1;
      }
    },
    async cleanupNodeWorktree(input) {
      return cleanupNodeWorktree(input);
    },
    async runBroadReviewer(input) {
      return runFakeBroadReviewer({ milestoneId: input.milestoneId, emitGap: false });
    },
    async runBroadJudge(input) {
      return runFakeBroadJudge({ milestoneId: input.milestoneId, emitGap: false });
    },
  };
}

async function assertArtifactReadable(uri: string): Promise<void> {
  const content = await readFile(fileURLToPath(uri), 'utf8');
  assert.equal(content.length > 0, true);
}

function followupState(): FactoryRunState {
  return {
    runId: 'run-followup',
    status: 'executing_dag',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot: '/tmp/artifacts',
    nodes: {
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
      approvedBy: 'acceptance-test',
    },
  };
}

function humanGapRequest(): HumanGapRequest {
  return {
    requestId: 'human-gap-e2e',
    actor: 'acceptance-test',
    reason: 'acceptance follow-up',
    pauseScheduling: true,
    cancelNodeIds: ['node-a'],
    gapReport: {
      gapReportId: 'gap-e2e',
      source: 'human_intervention',
      summary: 'Acceptance follow-up gap.',
      gaps: [
        {
          id: 'gap-e2e-finding',
          severity: 'high',
          category: 'quality-gap',
          description: 'Add follow-up acceptance work.',
          affectedRequirements: ['REQ-1'],
          suggestedTasks: ['Add follow-up node.'],
          blocking: true,
        },
      ],
      recommendedPlan: 'repair_dag',
    },
  };
}

function followupDraft(riskLevel: TaskNode['riskLevel']): FollowupDagDraftResult {
  const plan = followupPlan(riskLevel);
  const snapshotManifest = manifestForPlan(plan);
  return {
    approvalPolicy: 'high-risk-only',
    summary: plan.summary,
    plan,
    planRef: {
      uri: 'file:///followup-plan.json',
      kind: 'plan-json',
      sha256: 'followup-plan-sha',
      createdAt: '2026-05-03T12:00:00.000Z',
      producer: 'acceptance-test',
    },
    snapshotManifest,
    snapshotManifestRef: {
      uri: 'file:///followup-snapshot.json',
      kind: 'plan-snapshot-manifest',
      sha256: 'followup-snapshot-sha',
      createdAt: '2026-05-03T12:00:00.000Z',
      producer: 'acceptance-test',
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
    plannerModel: 'acceptance-test',
    status: 'proposed',
    artifactUri: 'file:///followup-plan.json',
    summary: 'Follow-up acceptance DAG',
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
        acceptanceCriteria: ['Follow-up completes.'],
      },
    ],
    nodes: [
      {
        id: 'followup-node',
        milestoneId: 'followup-milestone',
        title: 'Follow-up node',
        kind: 'code',
        bodyUri: 'file:///followup-node.md',
        description: 'Implement follow-up.',
        requirements: ['Implement follow-up.'],
        specRequirementIds: ['REQ-1'],
        acceptanceCriteria: ['Follow-up passes.'],
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
    globalAcceptanceCriteria: ['Follow-up completes.'],
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

function parseCliOutput(stdout: string): CliRunOutput {
  try {
    return JSON.parse(stdout) as CliRunOutput;
  } catch (cause) {
    throw new Error(`CLI did not print valid JSON: ${stdout}`, { cause });
  }
}

function repoRootFromDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
