import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureRepository } from '@durafoundry/fixture-repo';
import { validatePlanDAG, validatePlanSnapshotManifest } from '@durafoundry/domain';

import {
  runFakeBroadJudge,
  runFakeBroadReviewer,
  runFakeCoder,
  runFakeGapPlanner,
  runFakeJudge,
  runFakePlanner,
  runFakeReviewer,
} from './index.js';

const fixedTime = '2026-05-03T12:00:00.000Z';

test('fake planner writes a valid plan bundle and snapshot manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-fake-plan-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'planner',
  });

  const result = await runFakePlanner({
    artifactRoot: join(root, 'artifacts'),
    specId: 'spec-1',
    specVersion: 'v1',
    repoId: 'fixture-repo',
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    createdAt: fixedTime,
  });

  assert.equal(result.bundle.plan.nodes.length, 2);
  assert.equal(result.bundle.plan.status, 'proposed');
  assert.equal(result.bundle.plan.nodes[0]?.bodyUri.startsWith('file://'), true);
  assert.deepEqual(validatePlanDAG(result.bundle.plan), { valid: true, errors: [] });
  assert.deepEqual(validatePlanSnapshotManifest(result.bundle.plan, result.snapshot.manifest), {
    valid: true,
    errors: [],
  });
});

test('fake coder edits fixture files and returns attempt context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-fake-coder-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'coder',
  });

  const attempt = await runFakeCoder({
    repoPath: fixture.repoPath,
    nodeId: 'fixture-alpha',
    attemptId: 'attempt-1',
    planSnapshotId: 'snapshot-1',
    artifactRoot: join(root, 'artifacts'),
    startedAt: fixedTime,
    completedAt: fixedTime,
  });

  assert.equal(await readFile(fixture.files.alpha, 'utf8'), 'fixture-alpha: implemented\n');
  assert.equal(attempt.nodeId, 'fixture-alpha');
  assert.equal(attempt.planSnapshotId, 'snapshot-1');
  assert.deepEqual(attempt.changedFiles, ['src/alpha.txt']);
  assert.match(attempt.diffUri, /^file:\/\//);
  assert.match(attempt.agentSessionUri, /^file:\/\//);
  assert.equal(attempt.testResults[0]?.status, 'passed');
});

test('fake reviewer and judge fail once then pass with node-local repair instructions', () => {
  const firstReview = runFakeReviewer({
    nodeId: 'fixture-alpha',
    attemptNumber: 1,
    failFirstAttempt: true,
    createdAt: fixedTime,
  });
  assert.equal(firstReview.report.status, 'fail');
  assert.equal(firstReview.report.failureClassification?.scope, 'node_local');
  assert.equal(firstReview.report.failureClassification?.recommendedAction, 'repair_node');
  assert.equal(firstReview.repairInstructions[0]?.source, 'review');
  assert.deepEqual(firstReview.repairInstructions[0]?.implicatedFiles, ['src/alpha.txt']);

  const secondReview = runFakeReviewer({
    nodeId: 'fixture-alpha',
    attemptNumber: 2,
    failFirstAttempt: true,
  });
  assert.equal(secondReview.report.status, 'pass');
  assert.deepEqual(secondReview.repairInstructions, []);

  const firstJudge = runFakeJudge({
    nodeId: 'fixture-beta',
    attemptNumber: 1,
    failFirstAttempt: true,
    createdAt: fixedTime,
  });
  assert.equal(firstJudge.report.status, 'fail');
  assert.equal(firstJudge.report.failureClassification?.scope, 'node_local');
  assert.equal(firstJudge.report.failureClassification?.recommendedAction, 'repair_node');
  assert.equal(firstJudge.repairInstructions[0]?.source, 'judge');
  assert.deepEqual(firstJudge.repairInstructions[0]?.implicatedFiles, ['src/beta.txt']);

  const secondJudge = runFakeJudge({
    nodeId: 'fixture-beta',
    attemptNumber: 2,
    failFirstAttempt: true,
  });
  assert.equal(secondJudge.report.status, 'pass');
  assert.deepEqual(secondJudge.repairInstructions, []);
});

test('broad gates can pass or produce milestone follow-up gap reports', () => {
  const passReview = runFakeBroadReviewer({ milestoneId: 'fixture-milestone' });
  assert.equal(passReview.report.status, 'pass');
  assert.equal(passReview.gapReport, undefined);

  const gapReview = runFakeBroadReviewer({
    milestoneId: 'fixture-milestone',
    emitGap: true,
  });
  assert.equal(gapReview.report.status, 'fail');
  assert.equal(gapReview.report.failureClassification?.scope, 'plan_gap');
  assert.equal(gapReview.gapReport?.source, 'milestone_review');
  assert.equal(gapReview.gapReport?.gaps[0]?.blocking, true);

  const gapJudge = runFakeBroadJudge({
    milestoneId: 'fixture-milestone',
    emitGap: true,
  });
  assert.equal(gapJudge.report.status, 'fail');
  assert.equal(gapJudge.report.failureClassification?.recommendedAction, 'create_followup_dag');
  assert.equal(gapJudge.gapReport?.source, 'milestone_judge');
});

test('fake gap planner turns broad findings into a valid follow-up graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durafoundry-fake-gap-'));
  const fixture = await createFixtureRepository({
    artifactRoot: root,
    fixtureRepoId: 'gap',
  });
  const planned = await runFakePlanner({
    artifactRoot: join(root, 'artifacts'),
    specId: 'spec-1',
    specVersion: 'v1',
    repoId: 'fixture-repo',
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
    createdAt: fixedTime,
  });
  const broad = runFakeBroadReviewer({
    milestoneId: 'fixture-milestone',
    emitGap: true,
  });
  assert.ok(broad.gapReport);

  const followup = await runFakeGapPlanner({
    artifactRoot: join(root, 'artifacts'),
    gapReport: broad.gapReport,
    parentPlan: {
      ...planned.bundle.plan,
      approvedSnapshotId: planned.snapshot.manifest.snapshotId,
    },
    createdAt: fixedTime,
  });

  assert.equal(followup.bundle.plan.parentDagId, planned.bundle.plan.dagId);
  assert.equal(followup.bundle.plan.parentSnapshotId, planned.snapshot.manifest.snapshotId);
  assert.equal(followup.bundle.plan.nodes.length, 1);
  assert.equal(followup.bundle.plan.nodes[0]?.id, 'followup-gap-followup-fixture');
  assert.deepEqual(validatePlanDAG(followup.bundle.plan), { valid: true, errors: [] });
  assert.deepEqual(validatePlanSnapshotManifest(followup.bundle.plan, followup.snapshot.manifest), {
    valid: true,
    errors: [],
  });
});
