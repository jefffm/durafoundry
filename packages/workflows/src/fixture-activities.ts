import {
  runFakeBroadJudge,
  runFakeBroadReviewer,
  runFakeCoder,
  runFakeJudge,
  runFakePlanner,
  runFakeReviewer,
} from '@durafoundry/fake-agent-activities';
import {
  cleanupNodeWorktree as runCleanupNodeWorktree,
  commitNodeChanges,
  createNodeWorktree,
  mergeNodeCommit as runMergeNodeCommit,
} from '@durafoundry/git-activities';

import type {
  BroadJudgeGateResult,
  BroadReviewGateResult,
  CleanupNodeWorktreeActivityInput,
  CleanupNodeWorktreeResult,
  DagExecutionActivities,
  FactoryRunActivities,
  FactoryRunInput,
  MergeNodeCommitActivityInput,
  MergeNodeCommitResult,
  NodeReviewGateResult,
  NodeVerificationGateResult,
  RunBroadGateActivityInput,
  RunGateActivityInput,
} from './contracts.js';

export interface FixtureActivityMapOptions {
  createdAt?: string;
  failFirstReviewAttempt?: boolean;
  failFirstJudgeAttempt?: boolean;
  emitBroadReviewGap?: boolean;
  emitBroadJudgeGap?: boolean;
  observer?: FixtureActivityObserver;
}

export type FixtureActivityMap = FactoryRunActivities & DagExecutionActivities;

export interface FixtureActivityObserver {
  onReviewResult?(input: RunGateActivityInput, result: NodeReviewGateResult): void | Promise<void>;
  onMergeNodeCommitStart?(input: MergeNodeCommitActivityInput): void | Promise<void>;
  onMergeNodeCommit?(
    input: MergeNodeCommitActivityInput,
    result: MergeNodeCommitResult,
  ): void | Promise<void>;
  onCleanupNodeWorktree?(
    input: CleanupNodeWorktreeActivityInput,
    result: CleanupNodeWorktreeResult,
  ): void | Promise<void>;
  onBroadReviewResult?(
    input: RunBroadGateActivityInput,
    result: BroadReviewGateResult,
  ): void | Promise<void>;
  onBroadJudgeResult?(
    input: RunBroadGateActivityInput,
    result: BroadJudgeGateResult,
  ): void | Promise<void>;
}

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
      const result = runFakeReviewer({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: options.failFirstReviewAttempt,
        createdAt: options.createdAt,
      });
      await options.observer?.onReviewResult?.(input, result);
      return result;
    },
    async runJudge(input) {
      return runFakeJudge({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: options.failFirstJudgeAttempt,
        createdAt: options.createdAt,
      });
    },
    async mergeNodeCommit(input) {
      await options.observer?.onMergeNodeCommitStart?.(input);
      const result = await runMergeNodeCommit(input);
      await options.observer?.onMergeNodeCommit?.(input, result);
      return result;
    },
    async cleanupNodeWorktree(input) {
      const result = await runCleanupNodeWorktree(input);
      await options.observer?.onCleanupNodeWorktree?.(input, result);
      return result;
    },
    async runBroadReviewer(input) {
      const result = runFakeBroadReviewer({
        milestoneId: input.milestoneId,
        emitGap: options.emitBroadReviewGap,
      });
      await options.observer?.onBroadReviewResult?.(input, result);
      return result;
    },
    async runBroadJudge(input) {
      const result = runFakeBroadJudge({
        milestoneId: input.milestoneId,
        emitGap: options.emitBroadJudgeGap,
      });
      await options.observer?.onBroadJudgeResult?.(input, result);
      return result;
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
