import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment as TemporalTestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker as TemporalWorker } from '@temporalio/worker';

export interface TemporalWorkerClientHarness {
  env: TemporalTestWorkflowEnvironment;
  worker: TemporalWorker;
  taskQueue: string;
  runUntil<R>(fn: () => Promise<R>): Promise<R>;
  teardown(): Promise<void>;
}

export interface CreateTemporalWorkerClientHarnessInput {
  activities: object;
  taskQueuePrefix?: string;
  workflowsPath?: string;
}

export async function createTemporalWorkerClientHarness(
  input: CreateTemporalWorkerClientHarnessInput,
): Promise<TemporalWorkerClientHarness> {
  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: {
        type: 'existing-path',
        path: resolveTemporalCliPath(),
      },
      ui: false,
      log: {
        format: 'pretty',
        level: 'warn',
      },
    },
  });
  const taskQueue = `${input.taskQueuePrefix ?? 'durafoundry-test'}-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace ?? 'default',
    taskQueue,
    workflowsPath: input.workflowsPath ?? new URL('./workflows.js', import.meta.url).pathname,
    activities: input.activities,
  });

  return {
    env,
    worker,
    taskQueue,
    runUntil: (fn) => worker.runUntil(fn),
    teardown: () => env.teardown(),
  };
}

function resolveTemporalCliPath(): string {
  if (process.env.TEMPORAL_CLI_PATH) {
    return process.env.TEMPORAL_CLI_PATH;
  }
  return execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim();
}
