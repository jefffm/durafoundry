import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commitNodeChanges,
  createNodeWorktree,
  cleanupNodeWorktree,
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
import type {
  DagExecutionActivities,
  ExecuteDagRequest,
  FactoryRunState,
  GitAuthorRef,
} from './contracts.js';
import { executeDagScaffold } from './scaffold.js';
import type {
  CommandResult,
  NodeAttemptResult,
  NodeId,
  PlanDAG,
  PlanSnapshotManifest,
  ReviewReport,
  TaskNode,
} from '@durafoundry/domain';

test('dag scheduler executes independent fixture nodes together and merges serially', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-dag-'));
  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'dag-real-git',
  });
  const planned = await runFakePlanner({
    artifactRoot,
    specId: 'spec-1',
    specVersion: 'v1',
    repoId: fixture.fixtureRepoId,
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    createdAt: '2026-05-03T12:00:00.000Z',
  });
  const state = approvedState(planned.bundle.plan, planned.snapshot.manifest);
  const mergeTracker = { active: 0, max: 0, order: [] as NodeId[] };

  const result = await executeDagScaffold(
    state,
    dagRequest(planned.bundle.plan, fixture.repoPath, artifactRoot),
    realFixtureActivities(artifactRoot, mergeTracker),
  );

  assert.equal(result.state.status, 'completed');
  assert.equal(result.maxObservedActiveNodes, 2);
  assert.equal(result.maxObservedMergeConcurrency, 1);
  assert.equal(mergeTracker.max, 1);
  assert.deepEqual(mergeTracker.order, ['fixture-alpha', 'fixture-beta']);
  assert.equal(result.mergedNodes.length, 2);
  assert.equal(result.cleanupResults.length, 2);
  assert.equal(result.cleanupResults.every((cleanup) => cleanup.removedWorktree), true);
  assert.equal(result.milestoneResults[0]?.review?.status, 'pass');
  assert.equal(result.milestoneResults[0]?.judge?.status, 'pass');
  assert.equal(state.nodes['fixture-alpha']?.status, 'merged');
  assert.equal(state.nodes['fixture-beta']?.status, 'merged');
  assert.equal(Object.isFrozen(state.nodes['fixture-alpha']), true);
  assert.equal(await readFile(fixture.files.alpha, 'utf8'), 'fixture-alpha: implemented\n');
  assert.equal(await readFile(fixture.files.beta, 'utf8'), 'fixture-beta: implemented\n');
});

test('dag scheduler blocks dependents until prerequisites merge', async () => {
  const plan = schedulerPlan({
    nodes: [
      schedulerNode('node-a', 'low'),
      schedulerNode('node-b', 'low'),
    ],
    edges: [{ from: 'node-a', to: 'node-b', reason: 'B depends on A.' }],
    maxActiveNodes: 2,
    maxActiveHighRiskNodes: 2,
  });
  const state = approvedState(plan);
  const starts: NodeId[] = [];
  const result = await executeDagScaffold(
    state,
    dagRequest(plan, '/tmp/repo', '/tmp/artifacts'),
    mockDagActivities({ starts }),
  );

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(starts, ['node-a', 'node-b']);
  assert.deepEqual(result.mergedNodes.map((merge) => merge.nodeId), ['node-a', 'node-b']);
});

test('dag scheduler enforces high-risk and total parallelism limits', async () => {
  const plan = schedulerPlan({
    nodes: [
      schedulerNode('node-a', 'high'),
      schedulerNode('node-b', 'high'),
      schedulerNode('node-c', 'low'),
    ],
    edges: [],
    maxActiveNodes: 2,
    maxActiveHighRiskNodes: 1,
  });
  const state = approvedState(plan);
  const batches: NodeId[][] = [];
  const result = await executeDagScaffold(
    state,
    dagRequest(plan, '/tmp/repo', '/tmp/artifacts'),
    mockDagActivities({ batches }),
  );

  assert.equal(result.state.status, 'completed');
  assert.equal(result.maxObservedActiveNodes, 2);
  assert.equal(result.maxObservedActiveHighRiskNodes, 1);
  assert.deepEqual(
    batches.filter((batch) => batch.length === 2),
    [['node-a', 'node-c']],
  );
  assert.deepEqual(batches.at(-1), ['node-b']);
});

test('dag scheduler finishes earlier milestones before later milestones', async () => {
  const plan = twoMilestonePlan();
  const state = approvedState(plan);
  const starts: NodeId[] = [];
  const result = await executeDagScaffold(
    state,
    dagRequest(plan, '/tmp/repo', '/tmp/artifacts'),
    mockDagActivities({ starts }),
  );

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(starts, ['node-a', 'node-b']);
  assert.deepEqual(
    result.milestoneResults.map((milestone) => milestone.milestoneId),
    ['milestone-1', 'milestone-2'],
  );
});

function dagRequest(plan: PlanDAG, repoPath: string, artifactRoot: string): ExecuteDagRequest {
  return {
    plan,
    repoPath,
    worktreeRoot: join(artifactRoot, 'worktrees'),
    artifactRoot,
    gitAuthor: gitAuthor(),
  };
}

function approvedState(
  plan: PlanDAG,
  manifest: PlanSnapshotManifest = fixtureManifest(plan),
): FactoryRunState {
  return {
    runId: 'run-1',
    status: 'executing_dag',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot: '/tmp/artifacts',
    nodes: Object.fromEntries(
      plan.nodes.map((node) => [
        node.id,
        {
          nodeId: node.id,
          status: 'ready' as const,
        },
      ]),
    ),
    paused: false,
    approvedSnapshot: {
      snapshotId: manifest.snapshotId,
      planId: plan.planId,
      dagId: plan.dagId,
      planArtifactUri: manifest.planJson.uri,
      planArtifactSha256: manifest.planJson.sha256,
      manifestUri: 'file:///snapshot.json',
      manifestSha256: 'snapshot-sha',
      approvedBy: 'test',
    },
  };
}

function realFixtureActivities(
  artifactRoot: string,
  mergeTracker: { active: number; max: number; order: NodeId[] },
): DagExecutionActivities {
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
          summary: 'Fixture verification passed.',
        },
        repairInstructions: [],
      };
    },
    async commitNodeChanges(input) {
      return commitNodeChanges({
        ...input,
        producer: '@durafoundry/workflows-test',
        now: () => '2026-05-03T12:00:00.000Z',
      });
    },
    async runReviewer(input) {
      return runFakeReviewer({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: false,
        createdAt: '2026-05-03T12:00:00.000Z',
      });
    },
    async runJudge(input) {
      return runFakeJudge({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: false,
        createdAt: '2026-05-03T12:00:00.000Z',
      });
    },
    async mergeNodeCommit(input) {
      const nodeId = nodeIdFromBranch(input.branchName);
      mergeTracker.active += 1;
      mergeTracker.max = Math.max(mergeTracker.max, mergeTracker.active);
      mergeTracker.order.push(nodeId);
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

function mockDagActivities(input: {
  starts?: NodeId[];
  batches?: NodeId[][];
} = {}): DagExecutionActivities {
  let activeNodes: NodeId[] = [];
  return {
    async createNodeWorktree(request) {
      return {
        repoPath: request.repoPath,
        worktreePath: `/tmp/worktrees/${request.nodeId}`,
        branchName: `durafoundry/${request.runId}/${request.nodeId}`,
        baseRef: request.baseRef ?? request.trunkBranch,
        baseCommitSha: 'base-sha',
      };
    },
    async runCoder(request) {
      input.starts?.push(request.nodeId);
      activeNodes.push(request.nodeId);
      input.batches?.push([...activeNodes]);
      return fakeAttempt(request.nodeId, request.attemptId, request.planSnapshotId);
    },
    async runVerification(request) {
      return {
        result: {
          command: request.command,
          status: 'passed',
          summary: 'Verification passed.',
        },
        repairInstructions: [],
      };
    },
    async commitNodeChanges(request) {
      const nodeId = request.nodeId;
      return {
        worktreePath: request.worktreePath,
        branchName: `durafoundry/run-1/${nodeId}`,
        commitSha: `commit-${nodeId}`,
        changedFiles: [`src/${nodeId}.txt`],
        diffUri: `file:///diff-${nodeId}.patch`,
        commandsRun: [commandResult('git commit')],
      };
    },
    async runReviewer(request) {
      activeNodes = activeNodes.filter((nodeId) => nodeId !== request.nodeId);
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
        trunkHeadAfter: `merge-${nodeIdFromBranch(input.branchName)}`,
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
    async runBroadReviewer(input) {
      return {
        report: {
          ...passReviewReport(input.milestoneId),
          milestoneId: input.milestoneId,
          nodeId: undefined,
          reviewerRole: 'broad_reviewer',
        },
      };
    },
    async runBroadJudge(input) {
      return {
        report: {
          ...passJudgeReport(input.milestoneId),
          milestoneId: input.milestoneId,
          nodeId: undefined,
          judgeRole: 'broad_judge',
        },
      };
    },
  };
}

function schedulerPlan(input: {
  nodes: TaskNode[];
  edges: PlanDAG['edges'];
  maxActiveNodes: number;
  maxActiveHighRiskNodes: number;
}): PlanDAG {
  return {
    planId: 'plan-1',
    dagId: 'dag-1',
    specId: 'spec-1',
    specVersion: 'v1',
    createdAt: '2026-05-03T12:00:00.000Z',
    plannerModel: 'test',
    status: 'approved',
    artifactUri: 'file:///plan.json',
    summary: 'Scheduler plan',
    assumptions: [],
    milestones: [
      {
        id: 'milestone-1',
        title: 'Milestone 1',
        description: 'Scheduler milestone.',
        nodeIds: input.nodes.map((node) => node.id),
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['All scheduler nodes merge.'],
      },
    ],
    nodes: input.nodes,
    edges: input.edges,
    globalAcceptanceCriteria: ['Plan completes.'],
    parallelism: {
      maxActiveNodes: input.maxActiveNodes,
      maxActiveHighRiskNodes: input.maxActiveHighRiskNodes,
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

function twoMilestonePlan(): PlanDAG {
  const first = schedulerNode('node-a', 'low');
  const second = {
    ...schedulerNode('node-b', 'low'),
    milestoneId: 'milestone-2',
  };
  return {
    ...schedulerPlan({
      nodes: [first, second],
      edges: [],
      maxActiveNodes: 2,
      maxActiveHighRiskNodes: 2,
    }),
    milestones: [
      {
        id: 'milestone-1',
        title: 'Milestone 1',
        description: 'First milestone.',
        nodeIds: ['node-a'],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['First milestone merges.'],
      },
      {
        id: 'milestone-2',
        title: 'Milestone 2',
        description: 'Second milestone.',
        nodeIds: ['node-b'],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['Second milestone merges.'],
      },
    ],
  };
}

function schedulerNode(id: NodeId, riskLevel: TaskNode['riskLevel']): TaskNode {
  return {
    id,
    milestoneId: 'milestone-1',
    title: id,
    kind: 'code',
    bodyUri: `file:///${id}.md`,
    description: `Update ${id}.`,
    requirements: [`Update ${id}.`],
    specRequirementIds: ['REQ-1'],
    acceptanceCriteria: [`${id} passes.`],
    expectedFiles: [`src/${id}.txt`],
    verificationCommands: ['npm test'],
    reviewerFocus: ['Review node.'],
    judgeRubric: ['Judge node.'],
    riskLevel,
    worktree: {
      mode: 'per-node',
      baseRef: 'main',
      cleanup: 'after-merge',
    },
    maxAttempts: 1,
  };
}

function fakeAttempt(
  nodeId: NodeId,
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

function passJudgeReport(id: string) {
  return {
    reportId: `judge-${id}`,
    nodeId: id,
    judgeRole: 'judge' as const,
    status: 'pass' as const,
    summary: 'Judge passed.',
    requirementResults: [],
    cutCornerFindings: [],
    requiredFixes: [],
    evidenceUris: [],
  };
}

function fixtureManifest(plan: PlanDAG): PlanSnapshotManifest {
  return {
    snapshotId: 'snapshot-1',
    planJson: {
      uri: 'file:///plan.json',
      sha256: 'plan-sha',
      kind: 'plan-json',
    },
    nodeBodies: Object.fromEntries(
      plan.nodes.map((node) => [
        node.id,
        {
          uri: node.bodyUri,
          sha256: `${node.id}-body-sha`,
          kind: 'node-body' as const,
        },
      ]),
    ),
    milestoneBodies: Object.fromEntries(
      plan.milestones.map((milestone) => [
        milestone.id,
        {
          uri: `file:///${milestone.id}.md`,
          sha256: `${milestone.id}-body-sha`,
          kind: 'milestone-body' as const,
        },
      ]),
    ),
    createdAt: '2026-05-03T12:00:00.000Z',
  };
}

function gitAuthor(): GitAuthorRef {
  return {
    name: 'DuraFoundry',
    email: 'durafoundry@example.invalid',
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

function nodeIdFromBranch(branchName: string): NodeId {
  return branchName.split('/').at(-1) ?? branchName;
}
