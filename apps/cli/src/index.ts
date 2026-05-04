#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client, Connection, type WorkflowHandleWithStartDetails } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  approvePlanUpdate,
  createFixtureActivityMap,
  factoryRunWorkflow,
  getRunStateQuery,
  type FixtureActivityMapOptions,
  type FactoryRunInput,
  type FactoryRunState,
} from '@durafoundry/workflows';
import {
  cleanupFixtureRepository,
  createFixtureRepository,
  type FixtureRepository,
} from '@durafoundry/fixture-repo';

export interface CliRunOutput {
  runId: string;
  temporalRunId: string;
  workflowId: string;
  taskQueue: string;
  temporalAddress: string;
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
  temporalAddress: string;
  taskQueue?: string;
  autoApprove: boolean;
  startWorker: boolean;
  preserveFixture: boolean;
}

export interface CliRunOptions {
  fixtureActivities?: FixtureActivityMapOptions;
  onStateSample?(state: FactoryRunState): void | Promise<void>;
}

interface TemporalRunContext {
  input: FactoryRunInput;
  workflowId: string;
  taskQueue: string;
  temporalAddress: string;
  fixture: FixtureRepository;
}

const planApprovalPollMs = 200;
const planApprovalTimeoutMs = 15_000;

export async function runCli(argv: string[]): Promise<CliRunOutput> {
  return runCliWithOptions(argv);
}

export async function runCliWithOptions(
  argv: string[],
  options: CliRunOptions = {},
): Promise<CliRunOutput> {
  const args = parseRunArgs(argv);
  const artifactRoot = resolve(args.artifactRoot);
  const specPath = resolve(args.specPath);
  const specBytes = await readFile(specPath);
  const specSha256 = sha256Hex(specBytes);
  const runId = `run-${randomUUID()}`;

  if (!args.fixtureRepo) {
    throw new Error('The v0 CLI demo requires --fixture-repo so it never targets this repository.');
  }
  if (!args.autoApprove) {
    throw new Error('The v0 Temporal CLI requires --auto-approve until external approval is wired.');
  }

  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: runId,
  });

  try {
    const specId = `spec-${specSha256.slice(0, 12)}`;
    const taskQueue = args.taskQueue ?? `durafoundry-${runId}`;
    const workflowId = `factory:${fixture.fixtureRepoId}:${specId}:${runId}`;
    const context: TemporalRunContext = {
      input: {
        runId,
        specUri: pathToFileURL(specPath).href,
        specSha256,
        artifactRoot,
        runtime: {
          repoPath: fixture.repoPath,
          trunkBranch: fixture.trunkBranch,
          worktreeRoot: resolve(artifactRoot, 'worktrees'),
          gitAuthor: {
            name: 'DuraFoundry CLI',
            email: 'cli@durafoundry.local',
          },
        },
      },
      workflowId,
      taskQueue,
      temporalAddress: args.temporalAddress,
      fixture,
    };

    const output = args.startWorker
      ? await runWithInProcessWorker(context, options)
      : await runWithExternalWorker(context, options);
    if (
      output.finalStatus !== 'completed' &&
      !(args.allowNeedsHuman && output.finalStatus === 'needs_human')
    ) {
      throw new CliRunFailedError(output);
    }
    return output;
  } finally {
    if (!args.preserveFixture) {
      await cleanupFixtureRepository({ artifactRoot, fixtureRepoId: fixture.fixtureRepoId });
    }
  }
}

async function runWithInProcessWorker(
  context: TemporalRunContext,
  options: CliRunOptions,
): Promise<CliRunOutput> {
  let connection: NativeConnection | undefined;
  try {
    connection = await connectNativeTemporal(context.temporalAddress);
  } catch (cause) {
    throw new Error(`Unable to connect to Temporal at ${context.temporalAddress}.`, { cause });
  }

  try {
    const worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue: context.taskQueue,
      workflowsPath: workflowsPathFromCliDist(),
      activities: createFixtureActivityMap(options.fixtureActivities),
    });
    const client = new Client({ connection, namespace: 'default' });
    return await worker.runUntil(() => runWorkflowWithClient(client, context, options));
  } catch (cause) {
    throw new Error(`Unable to start or run Temporal worker at ${context.temporalAddress}.`, {
      cause,
    });
  } finally {
    await connection.close();
  }
}

async function runWithExternalWorker(
  context: TemporalRunContext,
  options: CliRunOptions,
): Promise<CliRunOutput> {
  let connection: Connection | undefined;
  try {
    connection = await Connection.connect({
      address: context.temporalAddress,
      connectTimeout: '3s',
    });
  } catch (cause) {
    throw new Error(`Unable to connect to Temporal at ${context.temporalAddress}.`, { cause });
  }

  try {
    const client = new Client({ connection, namespace: 'default' });
    return await runWorkflowWithClient(client, context, options);
  } finally {
    await connection.close();
  }
}

async function runWorkflowWithClient(
  client: Client,
  context: TemporalRunContext,
  options: CliRunOptions,
): Promise<CliRunOutput> {
  const handle = await client.workflow.start(factoryRunWorkflow, {
    args: [context.input],
    taskQueue: context.taskQueue,
    workflowId: context.workflowId,
  });
  const approvedPlan = await waitForPlanApprovalState(handle, options);
  await handle.executeUpdate(approvePlanUpdate, {
    args: [
      {
        planId: approvedPlan.plan.planId,
        artifactUri: approvedPlan.plan.artifactUri,
        artifactSha256: approvedPlan.plan.artifactSha256,
        actor: 'cli-auto-approve',
      },
    ],
  });
  await sampleWorkflowState(handle, options);
  const finalState = await waitForWorkflowResult(handle, options);
  return toCliOutput(context, handle.firstExecutionRunId, finalState);
}

async function waitForPlanApprovalState(
  handle: WorkflowHandleWithStartDetails<typeof factoryRunWorkflow>,
  options: CliRunOptions,
): Promise<FactoryRunState & { plan: NonNullable<FactoryRunState['plan']> }> {
  const deadline = Date.now() + planApprovalTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let state: FactoryRunState | undefined;
    try {
      state = await handle.query(getRunStateQuery);
      await options.onStateSample?.(state);
    } catch (error) {
      lastError = error;
    }
    if (state?.status === 'waiting_for_plan_approval' && state.plan) {
      return state as FactoryRunState & { plan: NonNullable<FactoryRunState['plan']> };
    }
    if (
      state?.status === 'plan_rejected' ||
      state?.status === 'changes_requested' ||
      state?.status === 'failed' ||
      state?.status === 'needs_human'
    ) {
      throw new Error(`Workflow cannot be auto-approved from status ${state.status}.`);
    }
    await sleep(planApprovalPollMs);
  }
  throw new Error('Timed out waiting for Temporal workflow plan approval state.', {
    cause: lastError,
  });
}

async function waitForWorkflowResult(
  handle: WorkflowHandleWithStartDetails<typeof factoryRunWorkflow>,
  options: CliRunOptions,
): Promise<FactoryRunState> {
  let completed = false;
  const result = handle.result().finally(() => {
    completed = true;
  });

  while (!completed) {
    await Promise.race([sleep(100), result.then(() => undefined)]);
    if (!completed) {
      await sampleWorkflowState(handle, options);
    }
  }

  return result;
}

async function sampleWorkflowState(
  handle: WorkflowHandleWithStartDetails<typeof factoryRunWorkflow>,
  options: CliRunOptions,
): Promise<void> {
  try {
    await options.onStateSample?.(await handle.query(getRunStateQuery));
  } catch {
    // Query sampling is best-effort; workflow completion can race with the sample.
  }
}

function toCliOutput(
  context: TemporalRunContext,
  temporalRunId: string,
  state: FactoryRunState,
): CliRunOutput {
  return {
    runId: context.input.runId,
    temporalRunId,
    workflowId: context.workflowId,
    taskQueue: context.taskQueue,
    temporalAddress: context.temporalAddress,
    artifactRoot: context.input.artifactRoot,
    fixtureRepoPath: context.fixture.repoPath,
    planId: state.plan?.planId ?? '',
    dagId: state.plan?.dagId ?? '',
    snapshotId: state.approvedSnapshot?.snapshotId ?? state.plan?.snapshotId ?? '',
    nodeCommits: Object.fromEntries(
      Object.entries(state.nodeRuns ?? {}).map(([nodeId, result]) => [
        nodeId,
        result.history.finalGatedCommitSha ?? '',
      ]),
    ),
    mergeCommits: Object.fromEntries(
      Object.entries(state.nodeRuns ?? {})
        .map(([nodeId, result]) => [nodeId, result.state.mergedCommitSha ?? ''] as const)
        .filter(([, mergeCommit]) => mergeCommit.length > 0),
    ),
    finalStatus: state.status,
  };
}

async function connectNativeTemporal(address: string): Promise<NativeConnection> {
  let timedOut = false;
  let timeoutId: NodeJS.Timeout | undefined;
  const pendingConnection = NativeConnection.connect({ address });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timed out connecting to Temporal at ${address}.`));
    }, 5_000);
  });

  try {
    return await Promise.race([pendingConnection, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    pendingConnection
      .then((connection) => {
        if (timedOut) {
          void connection.close();
        }
      })
      .catch(() => undefined);
  }
}

function parseRunArgs(argv: string[]): ParsedRunArgs {
  if (argv[0] !== 'run') {
    throw new Error(
      'Usage: durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry --start-worker --auto-approve',
    );
  }
  const parsed: Partial<ParsedRunArgs> = {
    fixtureRepo: false,
    allowNeedsHuman: false,
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    autoApprove: false,
    startWorker: false,
    preserveFixture: false,
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
    } else if (arg === '--temporal-address') {
      parsed.temporalAddress = requireValue(argv, (index += 1), '--temporal-address');
    } else if (arg === '--task-queue') {
      parsed.taskQueue = requireValue(argv, (index += 1), '--task-queue');
    } else if (arg === '--auto-approve') {
      parsed.autoApprove = true;
    } else if (arg === '--start-worker') {
      parsed.startWorker = true;
    } else if (arg === '--preserve-fixture') {
      parsed.preserveFixture = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.specPath || !parsed.artifactRoot) {
    throw new Error(
      'Usage: durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry --start-worker --auto-approve',
    );
  }
  return parsed as ParsedRunArgs;
}

function workflowsPathFromCliDist(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'packages',
    'workflows',
    'dist',
    'workflows.js',
  );
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
