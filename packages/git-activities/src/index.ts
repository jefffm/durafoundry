import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createLocalArtifactStore, sha256Hex } from '@durafoundry/artifact-store';
import type { ArtifactUri, CommandResult, NodeId, RunId } from '@durafoundry/domain';

const execFileAsync = promisify(execFile);

export const GIT_ACTIVITY_MARKER_VERSION = 1;
export const GIT_ACTIVITY_MARKER_SUFFIX = '.durafoundry-worktree.json';

export type GitActivityErrorCode =
  | 'not_git_repository'
  | 'missing_branch'
  | 'dirty_trunk'
  | 'dirty_worktree'
  | 'no_changes'
  | 'not_factory_owned'
  | 'commit_mismatch'
  | 'git_command_failed';

export class GitActivityError extends Error {
  constructor(
    readonly code: GitActivityErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GitActivityError';
  }
}

export interface GitAuthor {
  name: string;
  email: string;
}

export interface PrepareRepositoryInput {
  repoPath: string;
  trunkBranch: string;
  allowDirtyTrunk?: boolean;
}

export interface PrepareRepositoryResult {
  repoPath: string;
  repoRoot: string;
  trunkBranch: string;
  trunkHeadSha: string;
  clean: boolean;
}

export interface CreateNodeWorktreeInput {
  repoPath: string;
  trunkBranch: string;
  worktreeRoot: string;
  runId: RunId;
  nodeId: NodeId;
  baseRef?: string;
}

export interface CreateNodeWorktreeResult {
  repoPath: string;
  worktreePath: string;
  markerPath: string;
  branchName: string;
  baseRef: string;
  baseCommitSha: string;
}

export interface CommitNodeChangesInput {
  worktreePath: string;
  nodeId: NodeId;
  message: string;
  author: GitAuthor;
  artifactRoot?: string;
  producer?: string;
  now?: () => string;
}

export interface CommitNodeChangesResult {
  worktreePath: string;
  branchName: string;
  commitSha: string;
  changedFiles: string[];
  diffUri?: ArtifactUri;
  commandsRun: CommandResult[];
}

export interface MergeNodeCommitInput {
  repoPath: string;
  trunkBranch: string;
  branchName: string;
  author: GitAuthor;
  expectedCommitSha?: string;
}

export interface MergeNodeCommitResult {
  repoPath: string;
  trunkBranch: string;
  branchName: string;
  mergedCommitSha: string;
  trunkHeadBefore: string;
  trunkHeadAfter: string;
  commandsRun: CommandResult[];
}

export interface CleanupNodeWorktreeInput {
  repoPath: string;
  worktreePath: string;
  runId: RunId;
  nodeId?: NodeId;
  branchName?: string;
  removeBranch?: boolean;
}

export interface CleanupNodeWorktreeResult {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  removedWorktree: boolean;
  removedBranch: boolean;
  commandsRun: CommandResult[];
}

interface WorktreeMarker {
  markerVersion: typeof GIT_ACTIVITY_MARKER_VERSION;
  generatedBy: '@durafoundry/git-activities';
  repoPath: string;
  worktreePath: string;
  branchName: string;
  trunkBranch: string;
  runId: RunId;
  nodeId: NodeId;
}

interface GitResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function prepareRepository(
  input: PrepareRepositoryInput,
): Promise<PrepareRepositoryResult> {
  const repoPath = resolve(input.repoPath);
  const repoRoot = await gitStdout(['rev-parse', '--show-toplevel'], repoPath).catch((cause) => {
    throw new GitActivityError('not_git_repository', `Not a git repository: ${repoPath}`, {
      repoPath,
      cause,
    });
  });

  await assertBranchExists(repoPath, input.trunkBranch);
  const trunkHeadSha = await gitStdout(['rev-parse', input.trunkBranch], repoPath);
  const status = await gitStdout(['status', '--porcelain'], repoPath);
  const clean = status.trim() === '';

  if (!clean && !input.allowDirtyTrunk) {
    throw new GitActivityError('dirty_trunk', `Refusing dirty trunk repository: ${repoPath}`, {
      repoPath,
      trunkBranch: input.trunkBranch,
      status,
    });
  }

  return {
    repoPath,
    repoRoot: repoRoot.trim(),
    trunkBranch: input.trunkBranch,
    trunkHeadSha: trunkHeadSha.trim(),
    clean,
  };
}

export async function createNodeWorktree(
  input: CreateNodeWorktreeInput,
): Promise<CreateNodeWorktreeResult> {
  await prepareRepository({
    repoPath: input.repoPath,
    trunkBranch: input.trunkBranch,
  });

  const repoPath = resolve(input.repoPath);
  const worktreeRoot = resolve(input.worktreeRoot);
  const runSegment = safePathSegment(input.runId);
  const nodeSegment = safePathSegment(input.nodeId);
  const worktreePath = join(worktreeRoot, runSegment, nodeSegment);
  const branchName = `durafoundry/${runSegment}/${nodeSegment}`;
  const baseRef = input.baseRef ?? input.trunkBranch;
  const baseCommitSha = (await gitStdout(['rev-parse', baseRef], repoPath)).trim();

  await mkdir(dirname(worktreePath), { recursive: true });
  await git(['worktree', 'add', '-B', branchName, worktreePath, baseRef], repoPath);

  const markerPath = markerPathForWorktree(worktreePath);
  await writeMarker(markerPath, {
    markerVersion: GIT_ACTIVITY_MARKER_VERSION,
    generatedBy: '@durafoundry/git-activities',
    repoPath,
    worktreePath: resolve(worktreePath),
    branchName,
    trunkBranch: input.trunkBranch,
    runId: input.runId,
    nodeId: input.nodeId,
  });

  return {
    repoPath,
    worktreePath: resolve(worktreePath),
    markerPath,
    branchName,
    baseRef,
    baseCommitSha,
  };
}

export async function commitNodeChanges(
  input: CommitNodeChangesInput,
): Promise<CommitNodeChangesResult> {
  const worktreePath = resolve(input.worktreePath);
  await assertCleanIndexOrWorktreeHasChanges(worktreePath);

  const commandsRun: CommandResult[] = [];
  commandsRun.push(toCommandResult('git add -A', worktreePath, await git(['add', '-A'], worktreePath)));

  const changedFiles = splitLines(await gitStdout(['diff', '--cached', '--name-only'], worktreePath));
  if (changedFiles.length === 0) {
    throw new GitActivityError('no_changes', `No node changes to commit: ${worktreePath}`, {
      worktreePath,
      nodeId: input.nodeId,
    });
  }

  const diff = await gitStdout(['diff', '--cached', '--binary'], worktreePath);
  const diffSha = sha256Hex(Buffer.from(diff, 'utf8'));
  const diffUri = input.artifactRoot
    ? (
        await createLocalArtifactStore({
          rootDir: input.artifactRoot,
          now: input.now,
        }).writeArtifact({
          kind: 'git-diff',
          producer: input.producer ?? '@durafoundry/git-activities',
          content: diff,
          relativePath: join(
            'git',
            safePathSegment(input.nodeId),
            `${diffSha}.patch`,
          ),
        })
      ).uri
    : undefined;

  commandsRun.push(
    toCommandResult(
      `git commit -m ${JSON.stringify(input.message)}`,
      worktreePath,
      await git(
        [
          '-c',
          `user.name=${input.author.name}`,
          '-c',
          `user.email=${input.author.email}`,
          'commit',
          '-m',
          input.message,
        ],
        worktreePath,
      ),
    ),
  );

  const commitSha = (await gitStdout(['rev-parse', 'HEAD'], worktreePath)).trim();
  const branchName = (await gitStdout(['branch', '--show-current'], worktreePath)).trim();

  return {
    worktreePath,
    branchName,
    commitSha,
    changedFiles,
    diffUri,
    commandsRun,
  };
}

export async function mergeNodeCommit(
  input: MergeNodeCommitInput,
): Promise<MergeNodeCommitResult> {
  const repoPath = resolve(input.repoPath);
  await prepareRepository({ repoPath, trunkBranch: input.trunkBranch });
  await assertBranchExists(repoPath, input.branchName);

  const commandsRun: CommandResult[] = [];
  const mergedCommitSha = (await gitStdout(['rev-parse', input.branchName], repoPath)).trim();
  if (input.expectedCommitSha && input.expectedCommitSha !== mergedCommitSha) {
    throw new GitActivityError(
      'commit_mismatch',
      `Branch ${input.branchName} no longer points at expected commit`,
      {
        branchName: input.branchName,
        expectedCommitSha: input.expectedCommitSha,
        actualCommitSha: mergedCommitSha,
      },
    );
  }

  const trunkHeadBefore = (await gitStdout(['rev-parse', input.trunkBranch], repoPath)).trim();
  commandsRun.push(
    toCommandResult(
      `git checkout ${input.trunkBranch}`,
      repoPath,
      await git(['checkout', input.trunkBranch], repoPath),
    ),
  );
  commandsRun.push(
    toCommandResult(
      `git merge --no-ff --no-edit ${input.branchName}`,
      repoPath,
      await git(
        [
          '-c',
          `user.name=${input.author.name}`,
          '-c',
          `user.email=${input.author.email}`,
          'merge',
          '--no-ff',
          '--no-edit',
          input.branchName,
        ],
        repoPath,
      ),
    ),
  );
  const trunkHeadAfter = (await gitStdout(['rev-parse', input.trunkBranch], repoPath)).trim();

  return {
    repoPath,
    trunkBranch: input.trunkBranch,
    branchName: input.branchName,
    mergedCommitSha,
    trunkHeadBefore,
    trunkHeadAfter,
    commandsRun,
  };
}

export async function cleanupNodeWorktree(
  input: CleanupNodeWorktreeInput,
): Promise<CleanupNodeWorktreeResult> {
  const repoPath = resolve(input.repoPath);
  const worktreePath = resolve(input.worktreePath);
  const marker = await readMarker(markerPathForWorktree(worktreePath));

  if (
    marker.repoPath !== repoPath ||
    marker.worktreePath !== worktreePath ||
    marker.runId !== input.runId ||
    (input.nodeId && marker.nodeId !== input.nodeId) ||
    (input.branchName && marker.branchName !== input.branchName)
  ) {
    throw new GitActivityError('not_factory_owned', `Refusing to clean non-matching worktree`, {
      marker,
      input,
    });
  }

  const commandsRun: CommandResult[] = [];
  commandsRun.push(
    toCommandResult(
      `git worktree remove --force ${worktreePath}`,
      repoPath,
      await git(['worktree', 'remove', '--force', worktreePath], repoPath),
    ),
  );
  await rm(markerPathForWorktree(worktreePath), { force: true });

  let removedBranch = false;
  if (input.removeBranch ?? true) {
    commandsRun.push(
      toCommandResult(
        `git branch -D ${marker.branchName}`,
        repoPath,
        await git(['branch', '-D', marker.branchName], repoPath),
      ),
    );
    removedBranch = true;
  }

  return {
    repoPath,
    worktreePath,
    branchName: marker.branchName,
    removedWorktree: true,
    removedBranch,
    commandsRun,
  };
}

function markerPathForWorktree(worktreePath: string): string {
  return `${resolve(worktreePath)}${GIT_ACTIVITY_MARKER_SUFFIX}`;
}

async function writeMarker(markerPath: string, marker: WorktreeMarker): Promise<void> {
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

async function readMarker(markerPath: string): Promise<WorktreeMarker> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch (cause) {
    throw new GitActivityError('not_factory_owned', `Missing or invalid worktree marker`, {
      markerPath,
      cause,
    });
  }

  if (!isWorktreeMarker(parsed)) {
    throw new GitActivityError('not_factory_owned', `Invalid worktree marker`, {
      markerPath,
      parsed,
    });
  }

  return parsed;
}

async function assertBranchExists(repoPath: string, branchName: string): Promise<void> {
  await git(['rev-parse', '--verify', branchName], repoPath).catch((cause) => {
    throw new GitActivityError('missing_branch', `Missing git branch: ${branchName}`, {
      repoPath,
      branchName,
      cause,
    });
  });
}

async function assertCleanIndexOrWorktreeHasChanges(worktreePath: string): Promise<void> {
  const status = await gitStdout(['status', '--porcelain'], worktreePath);
  if (status.trim() === '') {
    throw new GitActivityError('no_changes', `No worktree changes found: ${worktreePath}`, {
      worktreePath,
    });
  }
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).stdout;
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (isExecError(error)) {
      throw new GitActivityError(
        'git_command_failed',
        `git ${args.join(' ')} failed in ${cwd}`,
        {
          cwd,
          args,
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.code,
        },
      );
    }

    throw error;
  }
}

function toCommandResult(command: string, cwd: string, result: GitResult): CommandResult {
  return {
    command,
    cwd,
    exitCode: 0,
    durationMs: result.durationMs,
  };
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`Invalid path segment: ${value}`);
  }

  return safe;
}

function isWorktreeMarker(value: unknown): value is WorktreeMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as WorktreeMarker).markerVersion === GIT_ACTIVITY_MARKER_VERSION &&
    (value as WorktreeMarker).generatedBy === '@durafoundry/git-activities' &&
    typeof (value as WorktreeMarker).repoPath === 'string' &&
    typeof (value as WorktreeMarker).worktreePath === 'string' &&
    typeof (value as WorktreeMarker).branchName === 'string' &&
    typeof (value as WorktreeMarker).trunkBranch === 'string' &&
    typeof (value as WorktreeMarker).runId === 'string' &&
    typeof (value as WorktreeMarker).nodeId === 'string'
  );
}

function isExecError(
  error: unknown,
): error is Error & { stdout: string; stderr: string; code: number } {
  return (
    error instanceof Error &&
    'stdout' in error &&
    typeof (error as { stdout: unknown }).stdout === 'string' &&
    'stderr' in error &&
    typeof (error as { stderr: unknown }).stderr === 'string' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  );
}
