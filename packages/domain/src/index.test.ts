import test from 'node:test';
import assert from 'node:assert/strict';

import type { PlanDAG, PlanSnapshotManifest } from './index.js';
import { validatePlanDAG, validatePlanSnapshotManifest } from './index.js';

const fixedTime = '2026-05-03T12:00:00.000Z';

test('accepts a valid plan DAG and matching snapshot manifest', () => {
  const plan = fixturePlan();
  const planResult = validatePlanDAG(plan);
  assert.deepEqual(planResult, { valid: true, errors: [] });

  const manifestResult = validatePlanSnapshotManifest(plan, fixtureManifest(plan));
  assert.deepEqual(manifestResult, { valid: true, errors: [] });
});

test('rejects dangling graph references and cycles', () => {
  const plan = fixturePlan({
    edges: [
      { from: 'node-alpha', to: 'node-beta', reason: 'Alpha before beta.' },
      { from: 'node-beta', to: 'node-alpha', reason: 'Invalid cycle.' },
      { from: 'missing-node', to: 'node-alpha', reason: 'Invalid source.' },
      { from: 'node-alpha', to: 'missing-target', reason: 'Invalid target.' },
    ],
  });

  const result = validatePlanDAG(plan);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Edge references missing from-node missing-node/);
  assert.match(result.errors.join('\n'), /Edge references missing to-node missing-target/);
  assert.match(result.errors.join('\n'), /Plan DAG contains cycle: node-alpha -> node-beta -> node-alpha/);
});

test('rejects missing milestone links, acceptance criteria, body refs, and verification', () => {
  const plan = fixturePlan({
    milestones: [
      {
        ...fixtureMilestone(),
        nodeIds: ['missing-node'],
        acceptanceCriteria: [],
      },
    ],
    nodes: [
      {
        ...fixtureNode('node-alpha'),
        milestoneId: 'missing-milestone',
        bodyUri: '',
        acceptanceCriteria: [],
        verificationCommands: [],
        riskLevel: 'high',
      },
    ],
  });

  const result = validatePlanDAG(plan);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /Milestone milestone-1 must have acceptance criteria/);
  assert.match(errors, /Milestone milestone-1 references missing node missing-node/);
  assert.match(errors, /Node node-alpha references missing milestone missing-milestone/);
  assert.match(errors, /Node node-alpha must have a body URI/);
  assert.match(errors, /Node node-alpha must have acceptance criteria/);
  assert.match(errors, /Node node-alpha must have verification commands/);
  assert.match(errors, /High-risk node node-alpha must have verification commands/);
});

test('rejects snapshot manifest gaps, extra entries, kind mismatches, and URI mismatches', () => {
  const plan = fixturePlan();
  const manifest = fixtureManifest(plan, {
    planJson: {
      uri: plan.artifactUri,
      sha256: 'sha-plan',
      kind: 'node-body',
    },
    nodeBodies: {
      'node-alpha': {
        uri: 'file:///plan/node-alpha-wrong.md',
        sha256: 'sha-alpha',
        kind: 'milestone-body',
      },
      'extra-node': {
        uri: 'file:///plan/extra-node.md',
        sha256: 'sha-extra',
        kind: 'node-body',
      },
    },
    milestoneBodies: {
      'milestone-1': {
        uri: 'file:///plan/milestone-wrong.md',
        sha256: 'sha-milestone',
        kind: 'node-body',
      },
      'extra-milestone': {
        uri: 'file:///plan/extra-milestone.md',
        sha256: 'sha-extra',
        kind: 'milestone-body',
      },
    },
  });

  const result = validatePlanSnapshotManifest(plan, manifest);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /planJson entry must have kind plan-json/);
  assert.match(errors, /node body node-alpha must have kind node-body/);
  assert.match(errors, /node body node-alpha URI does not match plan bodyUri/);
  assert.match(errors, /missing node body for node-beta/);
  assert.match(errors, /extra node body for extra-node/);
  assert.match(errors, /milestone body milestone-1 must have kind milestone-body/);
  assert.match(errors, /milestone body milestone-1 URI does not match plan bodyUri/);
  assert.match(errors, /extra milestone body for extra-milestone/);
});

function fixturePlan(overrides: Partial<PlanDAG> = {}): PlanDAG {
  return {
    planId: 'plan-1',
    dagId: 'dag-1',
    specId: 'spec-1',
    specVersion: 'v1',
    createdAt: fixedTime,
    plannerModel: 'fixture-planner',
    status: 'approved',
    artifactUri: 'file:///plan/plan.json',
    summary: 'Fixture plan',
    assumptions: [],
    milestones: [fixtureMilestone()],
    nodes: [fixtureNode('node-alpha'), fixtureNode('node-beta')],
    edges: [{ from: 'node-alpha', to: 'node-beta', reason: 'Alpha before beta.' }],
    globalAcceptanceCriteria: ['Plan completes.'],
    parallelism: {
      maxActiveNodes: 2,
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
    ...overrides,
  };
}

function fixtureMilestone(): PlanDAG['milestones'][number] {
  return {
    id: 'milestone-1',
    title: 'Milestone 1',
    bodyUri: 'file:///plan/milestone-1.md',
    description: 'Complete the fixture milestone.',
    nodeIds: ['node-alpha', 'node-beta'],
    reviewPolicy: {
      runBroadReview: true,
      runBroadJudge: true,
      autoPlanGaps: true,
      requireApprovalForGapWork: 'high-risk-only',
    },
    acceptanceCriteria: ['Milestone behavior is complete.'],
  };
}

function fixtureNode(id: string): PlanDAG['nodes'][number] {
  return {
    id,
    milestoneId: 'milestone-1',
    title: id,
    kind: 'code',
    bodyUri: `file:///plan/${id}.md`,
    description: `Implement ${id}.`,
    requirements: [`Implement ${id}.`],
    specRequirementIds: ['REQ-1'],
    acceptanceCriteria: [`${id} is complete.`],
    expectedFiles: [`src/${id}.ts`],
    verificationCommands: ['npm test'],
    reviewerFocus: ['No unrelated files changed.'],
    judgeRubric: ['Acceptance criteria are satisfied.'],
    riskLevel: 'low',
    worktree: {
      mode: 'per-node',
      baseRef: 'main',
      cleanup: 'after-merge',
    },
    maxAttempts: 2,
  };
}

function fixtureManifest(
  plan: PlanDAG,
  overrides: Partial<PlanSnapshotManifest> = {},
): PlanSnapshotManifest {
  return {
    snapshotId: 'snapshot-1',
    planJson: {
      uri: plan.artifactUri,
      sha256: 'sha-plan',
      kind: 'plan-json',
    },
    nodeBodies: Object.fromEntries(
      plan.nodes.map((node) => [
        node.id,
        {
          uri: node.bodyUri,
          sha256: `sha-${node.id}`,
          kind: 'node-body' as const,
        },
      ]),
    ),
    milestoneBodies: Object.fromEntries(
      plan.milestones.map((milestone) => [
        milestone.id,
        {
          uri: milestone.bodyUri ?? `file:///plan/${milestone.id}.md`,
          sha256: `sha-${milestone.id}`,
          kind: 'milestone-body' as const,
        },
      ]),
    ),
    createdAt: fixedTime,
    ...overrides,
  };
}
