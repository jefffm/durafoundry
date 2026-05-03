import {
  runFakeBroadJudge,
  runFakeBroadReviewer,
  runFakeCoder,
  runFakeJudge,
  runFakePlanner,
  runFakeReviewer,
} from '@durafoundry/fake-agent-activities';
import {
  cleanupNodeWorktree,
  commitNodeChanges,
  createNodeWorktree,
  mergeNodeCommit,
} from '@durafoundry/git-activities';

import type {
  DagExecutionActivities,
  FactoryRunActivities,
  FactoryRunInput,
  NodeVerificationGateResult,
} from './contracts.js';

export interface FixtureActivityMapOptions {
  createdAt?: string;
  failFirstReviewAttempt?: boolean;
  failFirstJudgeAttempt?: boolean;
  emitBroadReviewGap?: boolean;
  emitBroadJudgeGap?: boolean;
}

export type FixtureActivityMap = FactoryRunActivities & DagExecutionActivities;

export function createFixtureActivityMap(
  options: FixtureActivityMapOptions = {},
): FixtureActivityMap {
  return {
    async createDraftPlan(input) {
      assertFixtureRuntime(input);
      const planned = await runFakePlanner({
        artifactRoot: input.artifactRoot,
        specId: input.specUri,
        specVersion: input.specSha256,
        repoId: input.runId,
        repoPath: input.runtime.repoPath,
        trunkBranch: input.runtime.trunkBranch,
        createdAt: options.createdAt,
      });
      return {
        plan: planned.bundle.plan,
        planRef: planned.bundle.planRef,
        snapshotManifest: planned.snapshot.manifest,
        snapshotManifestRef: planned.snapshot.manifestRef,
        summary: planned.bundle.plan.summary,
      };
    },
    createNodeWorktree,
    runCoder: runFakeCoder,
    async runVerification(input): Promise<NodeVerificationGateResult> {
      return {
        result: {
          command: input.command,
          status: 'passed',
          summary: 'Fixture verification passed.',
        },
        repairInstructions: [],
      };
    },
    commitNodeChanges,
    async runReviewer(input) {
      return runFakeReviewer({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: options.failFirstReviewAttempt,
        createdAt: options.createdAt,
      });
    },
    async runJudge(input) {
      return runFakeJudge({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: options.failFirstJudgeAttempt,
        createdAt: options.createdAt,
      });
    },
    mergeNodeCommit,
    cleanupNodeWorktree,
    async runBroadReviewer(input) {
      return runFakeBroadReviewer({
        milestoneId: input.milestoneId,
        emitGap: options.emitBroadReviewGap,
      });
    },
    async runBroadJudge(input) {
      return runFakeBroadJudge({
        milestoneId: input.milestoneId,
        emitGap: options.emitBroadJudgeGap,
      });
    },
  };
}

function assertFixtureRuntime(
  input: FactoryRunInput,
): asserts input is FactoryRunInput & { runtime: NonNullable<FactoryRunInput['runtime']> } {
  if (!input.runtime) {
    throw new Error('Fixture Activities require FactoryRunInput.runtime.');
  }
}
