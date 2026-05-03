import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { PlanDAG } from '@durafoundry/domain';

import { createLocalArtifactStore, sha256Hex } from './index.js';

const fixedTime = '2026-05-03T12:00:00.000Z';

test('writes and reads a sha256-addressed artifact', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'durafoundry-artifacts-'));
  const store = createLocalArtifactStore({ rootDir, now: () => fixedTime });

  const ref = await store.writeArtifact({
    kind: 'diff',
    producer: 'artifact-store-test',
    content: 'fixture diff\n',
  });

  assert.equal(ref.kind, 'diff');
  assert.equal(ref.createdAt, fixedTime);
  assert.equal(ref.producer, 'artifact-store-test');
  assert.equal(ref.sha256, sha256Hex(Buffer.from('fixture diff\n')));
  assert.match(ref.uri, /^file:\/\//);
  assert.equal(await store.readTextArtifact(ref), 'fixture diff\n');
});

test('writes a plan bundle and hashes snapshot manifest entries', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'durafoundry-plan-'));
  const store = createLocalArtifactStore({ rootDir, now: () => fixedTime });
  const plan = fixturePlan();

  const bundle = await store.writePlanBundle({
    plan,
    nodeBodies: {
      'fixture-alpha': '# Fixture Alpha\n\nEdit alpha.\n',
      'fixture-beta': '# Fixture Beta\n\nEdit beta.\n',
    },
    milestoneBodies: {
      'fixture-milestone': '# Fixture Milestone\n\nComplete fixture edits.\n',
    },
    producer: 'planner-test',
  });

  assert.equal(bundle.plan.artifactUri, bundle.planRef.uri);
  assert.equal(bundle.plan.nodes[0]?.bodyUri, bundle.nodeBodyRefs['fixture-alpha']?.uri);
  assert.equal(bundle.plan.milestones[0]?.bodyUri, bundle.milestoneBodyRefs['fixture-milestone']?.uri);

  const writtenPlan = await store.readTextArtifact(bundle.planRef);
  assert.match(writtenPlan, /"planId": "fixture-plan"/);
  assert.match(writtenPlan, /"bodyUri": "file:\/\//);

  const snapshot = await store.writeSnapshotManifest({
    snapshotId: 'snapshot-1',
    planId: bundle.plan.planId,
    planRef: bundle.planRef,
    nodeBodyRefs: bundle.nodeBodyRefs,
    milestoneBodyRefs: bundle.milestoneBodyRefs,
    producer: 'approval-test',
  });

  assert.equal(snapshot.manifest.snapshotId, 'snapshot-1');
  assert.equal(snapshot.manifest.planJson.kind, 'plan-json');
  assert.equal(snapshot.manifest.planJson.sha256, bundle.planRef.sha256);
  assert.equal(
    snapshot.manifest.nodeBodies['fixture-alpha']?.sha256,
    bundle.nodeBodyRefs['fixture-alpha']?.sha256,
  );
  assert.equal(
    snapshot.manifest.milestoneBodies['fixture-milestone']?.sha256,
    bundle.milestoneBodyRefs['fixture-milestone']?.sha256,
  );
  assert.match(snapshot.manifestRef.uri, /\/plans\/fixture-plan\/snapshots\/snapshot-1\.json$/);
});

test('rejects artifact paths that escape the artifact root', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'durafoundry-escape-'));
  await mkdir(join(rootDir, 'nested'));
  const store = createLocalArtifactStore({ rootDir, now: () => fixedTime });

  await assert.rejects(
    () =>
      store.writeArtifact({
        kind: 'bad',
        producer: 'artifact-store-test',
        content: 'bad',
        relativePath: '../bad.txt',
      }),
    /escapes root/,
  );
});

function fixturePlan(): PlanDAG {
  return {
    planId: 'fixture-plan',
    dagId: 'fixture-dag',
    specId: 'fixture-spec',
    specVersion: 'v1',
    createdAt: fixedTime,
    plannerModel: 'fake-planner',
    status: 'approved',
    artifactUri: 'pending',
    summary: 'Fixture plan',
    assumptions: [],
    milestones: [
      {
        id: 'fixture-milestone',
        title: 'Fixture milestone',
        description: 'Complete fixture edits.',
        nodeIds: ['fixture-alpha', 'fixture-beta'],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['Both fixture files are edited.'],
      },
    ],
    nodes: [
      fixtureNode('fixture-alpha', 'src/alpha.txt'),
      fixtureNode('fixture-beta', 'src/beta.txt'),
    ],
    edges: [],
    globalAcceptanceCriteria: ['Fixture run completes.'],
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
  };
}

function fixtureNode(id: string, expectedFile: string): PlanDAG['nodes'][number] {
  return {
    id,
    milestoneId: 'fixture-milestone',
    title: id,
    kind: 'code',
    bodyUri: 'pending',
    description: `Edit ${expectedFile}`,
    requirements: [`Edit ${expectedFile}`],
    specRequirementIds: ['REQ-1'],
    acceptanceCriteria: [`${expectedFile} contains the fixture edit.`],
    expectedFiles: [expectedFile],
    verificationCommands: ['cat test/fixture.test.txt'],
    reviewerFocus: ['No unrelated files changed.'],
    judgeRubric: ['Expected file was edited.'],
    riskLevel: 'low',
    worktree: {
      mode: 'per-node',
      baseRef: 'main',
      cleanup: 'after-merge',
    },
    maxAttempts: 2,
  };
}
