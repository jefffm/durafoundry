#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  runFakeBroadJudge,
  runFakeBroadReviewer,
  runFakeCoder,
  runFakeJudge,
  runFakePlanner,
  runFakeReviewer,
} from '@durafoundry/fake-agent-activities';
import { createFixtureRepository } from '@durafoundry/fixture-repo';
import {
  cleanupNodeWorktree,
  commitNodeChanges,
  createNodeWorktree,
  mergeNodeCommit,
} from '@durafoundry/git-activities';
import {
  applyDraftPlan,
  approvePlanState,
  createInitialFactoryRunState,
  executeDagScaffold,
  type DagExecutionActivities,
  type DagExecutionResult,
  type DraftPlanResult,
  type FactoryRunState,
} from '@durafoundry/workflows';

export interface CliRunOutput {
  runId: string;
  workflowId: string;
  artifactRoot: string;
  fixtureRepoPath: string;
  planId: string;
  dagId: string;
  snapshotId: string;
  nodeCommits: Record<string, string>;
  mergeCommits: Record<string, string>;
  finalStatus: FactoryRunState['status'];
}

interface ParsedRunArgs {
  specPath: string;
  artifactRoot: string;
  fixtureRepo: boolean;
  allowNeedsHuman: boolean;
}

export async function runCli(argv: string[]): Promise<CliRunOutput> {
  const args = parseRunArgs(argv);
  const artifactRoot = resolve(args.artifactRoot);
  const specPath = resolve(args.specPath);
  const specBytes = await readFile(specPath);
  const specSha256 = sha256Hex(specBytes);
  const runId = `run-${randomUUID()}`;

  if (!args.fixtureRepo) {
    throw new Error('The v0 CLI demo requires --fixture-repo so it never targets this repository.');
  }

  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: runId,
  });
  const specId = `spec-${specSha256.slice(0, 12)}`;
  const workflowId = `factory:${fixture.fixtureRepoId}:${specId}:${runId}`;
  const planned = await runFakePlanner({
    artifactRoot,
    specId,
    specVersion: 'v0',
    repoId: fixture.fixtureRepoId,
    repoPath: fixture.repoPath,
    trunkBranch: fixture.trunkBranch,
  });

  const draft: DraftPlanResult = {
    summary: planned.bundle.plan.summary,
    plan: planned.bundle.plan,
    planRef: planned.bundle.planRef,
    snapshotManifest: planned.snapshot.manifest,
    snapshotManifestRef: planned.snapshot.manifestRef,
  };
  const state = createInitialFactoryRunState({
    runId,
    specUri: pathToFileURL(specPath).href,
    specSha256,
    artifactRoot,
  });
  state.status = 'planning';
  applyDraftPlan(state, draft);
  const approval = approvePlanState(state, {
    planId: draft.plan.planId,
    artifactUri: draft.planRef.uri,
    artifactSha256: draft.planRef.sha256,
    actor: 'cli-auto-approve',
  });
  if (!approval.accepted) {
    throw new Error(approval.rejectedReason ?? 'CLI auto-approval failed.');
  }

  const result = await executeDagScaffold(
    state,
    {
      plan: draft.plan,
      repoPath: fixture.repoPath,
      worktreeRoot: resolve(artifactRoot, 'worktrees'),
      artifactRoot,
      gitAuthor: {
        name: 'DuraFoundry CLI',
        email: 'cli@durafoundry.local',
      },
    },
    cliActivities(artifactRoot),
  );

  const output = toCliOutput({
    runId,
    workflowId,
    artifactRoot,
    fixtureRepoPath: fixture.repoPath,
    planId: draft.plan.planId,
    dagId: draft.plan.dagId,
    snapshotId: draft.snapshotManifest.snapshotId,
    result,
  });
  if (output.finalStatus !== 'completed' && !(args.allowNeedsHuman && output.finalStatus === 'needs_human')) {
    throw new CliRunFailedError(output);
  }
  return output;
}

function cliActivities(artifactRoot: string): DagExecutionActivities {
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
          summary: 'CLI fixture verification passed.',
        },
        repairInstructions: [],
      };
    },
    async commitNodeChanges(input) {
      return commitNodeChanges({
        ...input,
        producer: '@durafoundry/cli',
      });
    },
    async runReviewer(input) {
      return runFakeReviewer({
        nodeId: input.nodeId,
        attemptNumber: input.attemptNumber,
        failFirstAttempt: false,
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
      return mergeNodeCommit(input);
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

function toCliOutput(input: {
  runId: string;
  workflowId: string;
  artifactRoot: string;
  fixtureRepoPath: string;
  planId: string;
  dagId: string;
  snapshotId: string;
  result: DagExecutionResult;
}): CliRunOutput {
  return {
    runId: input.runId,
    workflowId: input.workflowId,
    artifactRoot: input.artifactRoot,
    fixtureRepoPath: input.fixtureRepoPath,
    planId: input.planId,
    dagId: input.dagId,
    snapshotId: input.snapshotId,
    nodeCommits: Object.fromEntries(
      Object.entries(input.result.nodeResults).map(([nodeId, result]) => [
        nodeId,
        result.history.finalGatedCommitSha ?? '',
      ]),
    ),
    mergeCommits: Object.fromEntries(
      input.result.mergedNodes.map((merged) => [merged.nodeId, merged.merge.trunkHeadAfter]),
    ),
    finalStatus: input.result.state.status,
  };
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  if (argv[0] !== 'run') {
    throw new Error('Usage: durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry');
  }
  const parsed: Partial<ParsedRunArgs> = {
    fixtureRepo: false,
    allowNeedsHuman: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--spec') {
      parsed.specPath = requireValue(argv, (index += 1), '--spec');
    } else if (arg === '--artifact-root') {
      parsed.artifactRoot = requireValue(argv, (index += 1), '--artifact-root');
    } else if (arg === '--fixture-repo') {
      parsed.fixtureRepo = true;
    } else if (arg === '--allow-needs-human') {
      parsed.allowNeedsHuman = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.specPath || !parsed.artifactRoot) {
    throw new Error('Usage: durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry');
  }
  return parsed as ParsedRunArgs;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class CliRunFailedError extends Error {
  constructor(readonly output: CliRunOutput) {
    super(`DuraFoundry run finished with status ${output.finalStatus}`);
    this.name = 'CliRunFailedError';
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2))
    .then((output) => {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    })
    .catch((error: unknown) => {
      if (error instanceof CliRunFailedError) {
        process.stdout.write(`${JSON.stringify(error.output)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
