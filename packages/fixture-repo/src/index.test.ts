import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';

import {
  cleanupFixtureRepository,
  createFixtureRepository,
  FIXTURE_MARKER_FILE,
} from './index.js';

const execFileAsync = promisify(execFile);

test('creates a clean deterministic fixture git repository on main', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-'));

  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'fixture-a',
  });

  assert.equal(fixture.trunkBranch, 'main');
  assert.match(fixture.initialCommitSha, /^[0-9a-f]{40}$/);
  assert.equal(await git(['branch', '--show-current'], fixture.repoPath), 'main');
  assert.equal(await git(['status', '--porcelain'], fixture.repoPath), '');
  assert.equal(await readFile(fixture.files.alpha, 'utf8'), 'alpha: initial\n');
  assert.equal(await readFile(fixture.files.beta, 'utf8'), 'beta: initial\n');
  assert.equal(await readFile(fixture.files.test, 'utf8'), 'fixture test placeholder\n');

  const committedFiles = (await git(['ls-files'], fixture.repoPath)).split('\n').sort();
  assert.deepEqual(committedFiles, [
    'README.md',
    'src/alpha.txt',
    'src/beta.txt',
    'test/fixture.test.txt',
  ]);
});

test('uses stable fixture contents and initial commit across generated repos', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-stable-'));

  const first = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'first',
  });
  const second = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'second',
  });

  assert.equal(first.initialCommitSha, second.initialCommitSha);
});

test('refuses to overwrite an existing fixture unless requested', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-existing-'));
  await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'existing',
  });

  await assert.rejects(
    () =>
      createFixtureRepository({
        artifactRoot,
        fixtureRepoId: 'existing',
      }),
    /already exists/,
  );

  const overwritten = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'existing',
    overwrite: true,
  });
  assert.equal(await git(['status', '--porcelain'], overwritten.repoPath), '');
});

test('cleans up only marked fixture directories', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-cleanup-'));
  const fixture = await createFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'cleanup-target',
  });

  await access(join(fixture.fixtureRoot, FIXTURE_MARKER_FILE));
  await cleanupFixtureRepository({
    artifactRoot,
    fixtureRepoId: 'cleanup-target',
  });

  await assert.rejects(() => access(fixture.fixtureRoot));
});

test('refuses cleanup when the fixture marker is missing', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-unmarked-'));
  await mkdir(join(artifactRoot, 'fixtures', 'unmarked'), { recursive: true });

  await assert.rejects(
    () =>
      cleanupFixtureRepository({
        artifactRoot,
        fixtureRepoId: 'unmarked',
      }),
    /ENOENT/,
  );
});

test('refuses cleanup when the fixture marker is invalid JSON', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'durafoundry-fixture-invalid-marker-'));
  const fixtureRoot = join(artifactRoot, 'fixtures', 'invalid-marker');
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, FIXTURE_MARKER_FILE), '{not json');

  await assert.rejects(
    () =>
      cleanupFixtureRepository({
        artifactRoot,
        fixtureRepoId: 'invalid-marker',
      }),
    /invalid marker/,
  );

  await access(fixtureRoot);
});

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}
