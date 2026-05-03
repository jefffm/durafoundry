import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_FIXTURE_REPO_ID = 'fixture-repo';
export const FIXTURE_TRUNK_BRANCH = 'main';
export const FIXTURE_MARKER_FILE = '.durafoundry-fixture.json';

export interface FixtureRepositoryOptions {
  artifactRoot: string;
  fixtureRepoId?: string;
  overwrite?: boolean;
}

export interface FixtureRepository {
  fixtureRepoId: string;
  fixtureRoot: string;
  repoPath: string;
  trunkBranch: typeof FIXTURE_TRUNK_BRANCH;
  initialCommitSha: string;
  files: {
    readme: string;
    alpha: string;
    beta: string;
    test: string;
  };
}

export interface CleanupFixtureRepositoryOptions {
  artifactRoot: string;
  fixtureRepoId?: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

const fixedCommitDate = '2026-05-03T00:00:00Z';

export async function createFixtureRepository(
  options: FixtureRepositoryOptions,
): Promise<FixtureRepository> {
  const fixtureRepoId = options.fixtureRepoId ?? DEFAULT_FIXTURE_REPO_ID;
  const fixtureRoot = resolve(options.artifactRoot, 'fixtures', safePathSegment(fixtureRepoId));
  const repoPath = join(fixtureRoot, 'repo');

  if (options.overwrite) {
    await rm(fixtureRoot, { recursive: true, force: true });
  } else if (await pathExists(fixtureRoot)) {
    throw new Error(`Fixture repository already exists: ${fixtureRoot}`);
  }

  await mkdir(join(repoPath, 'src'), { recursive: true });
  await mkdir(join(repoPath, 'test'), { recursive: true });

  await writeFixtureFiles(repoPath);
  await writeMarker(fixtureRoot, fixtureRepoId, repoPath);

  await git(['init', '--initial-branch', FIXTURE_TRUNK_BRANCH], repoPath);
  await git(['add', '.'], repoPath);
  await git(
    [
      '-c',
      'user.name=DuraFoundry Fixture',
      '-c',
      'user.email=fixture@durafoundry.local',
      'commit',
      '-m',
      'Initialize fixture repository',
    ],
    repoPath,
    {
      GIT_AUTHOR_DATE: fixedCommitDate,
      GIT_COMMITTER_DATE: fixedCommitDate,
    },
  );

  const initialCommitSha = (await git(['rev-parse', 'HEAD'], repoPath)).stdout.trim();
  const status = (await git(['status', '--porcelain'], repoPath)).stdout.trim();
  if (status !== '') {
    throw new Error(`Fixture repository was not clean after initialization:\n${status}`);
  }

  return {
    fixtureRepoId,
    fixtureRoot,
    repoPath,
    trunkBranch: FIXTURE_TRUNK_BRANCH,
    initialCommitSha,
    files: fixtureFiles(repoPath),
  };
}

export async function cleanupFixtureRepository(
  options: CleanupFixtureRepositoryOptions,
): Promise<void> {
  const fixtureRepoId = options.fixtureRepoId ?? DEFAULT_FIXTURE_REPO_ID;
  const fixtureRoot = resolve(options.artifactRoot, 'fixtures', safePathSegment(fixtureRepoId));
  const markerPath = join(fixtureRoot, FIXTURE_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { fixtureRepoId?: string };

  if (marker.fixtureRepoId !== fixtureRepoId) {
    throw new Error(`Refusing to clean fixture with mismatched marker: ${fixtureRoot}`);
  }

  await rm(fixtureRoot, { recursive: true, force: true });
}

async function writeFixtureFiles(repoPath: string): Promise<void> {
  const files = fixtureFiles(repoPath);
  await writeFile(
    files.readme,
    '# DuraFoundry fixture\n\nGenerated disposable repository for v0 integration tests.\n',
  );
  await writeFile(files.alpha, 'alpha: initial\n');
  await writeFile(files.beta, 'beta: initial\n');
  await writeFile(files.test, 'fixture test placeholder\n');
}

async function writeMarker(
  fixtureRoot: string,
  fixtureRepoId: string,
  repoPath: string,
): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(
    join(fixtureRoot, FIXTURE_MARKER_FILE),
    `${JSON.stringify(
      {
        fixtureRepoId,
        repoPath,
        trunkBranch: FIXTURE_TRUNK_BRANCH,
        generatedBy: '@durafoundry/fixture-repo',
      },
      null,
      2,
    )}\n`,
  );
}

function fixtureFiles(repoPath: string): FixtureRepository['files'] {
  return {
    readme: join(repoPath, 'README.md'),
    alpha: join(repoPath, 'src', 'alpha.txt'),
    beta: join(repoPath, 'src', 'beta.txt'),
    test: join(repoPath, 'test', 'fixture.test.txt'),
  };
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (isExecError(error)) {
      throw new Error(
        `git ${args.join(' ')} failed in ${cwd}\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`,
      );
    }

    throw error;
  }
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`Invalid fixture repo id: ${value}`);
  }

  return safe;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isExecError(error: unknown): error is Error & { stdout: string; stderr: string } {
  return (
    error instanceof Error &&
    'stdout' in error &&
    typeof (error as { stdout: unknown }).stdout === 'string' &&
    'stderr' in error &&
    typeof (error as { stderr: unknown }).stderr === 'string'
  );
}
