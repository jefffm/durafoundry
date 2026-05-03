# DuraFoundry v0 Progress

This file is the handoff point for iterative `/goal` execution. Read it at the beginning of each turn before choosing the next chunk.

## Current State

- Last completed chunk: Chunk 2, Fake Agent Activities.
- Next chunk: Chunk 3, Temporal Workflow Scaffold.
- Current branch: `main`.
- Last validation date: 2026-05-03.

## Chunk Log

### Chunk 2: Fake Agent Activities

Status: complete.

Acceptance evidence:

- Added `@durafoundry/fake-agent-activities`.
- `runFakePlanner` writes a valid proposed plan bundle with node markdown bodies, milestone markdown bodies, and a snapshot manifest for validation.
- `runFakeCoder` edits fixture files and returns `NodeAttemptResult` attempt context including changed files, command result, test result, diff artifact URI, and fake session artifact URI.
- `runFakeReviewer` and `runFakeJudge` support fail-first-attempt behavior and return node-local repair instructions; subsequent attempts pass.
- `runFakeBroadReviewer` and `runFakeBroadJudge` can either pass or produce structured milestone/final `GapReport`s classified as follow-up graph work.
- `runFakeGapPlanner` converts broad gap findings into a valid follow-up `PlanDAG` with parent DAG/snapshot references.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/fake-agent-activities` passed.
- `npm test --workspace @durafoundry/fake-agent-activities` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged package diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: fake planner initially produced an `approved` plan, which would collapse the later workflow approval step.
- Fix: fake planner now emits a `proposed` plan, with test coverage asserting the status.

### Chunk 1: Real Git Activities

Status: complete.

Acceptance evidence:

- Added `@durafoundry/git-activities`.
- `prepareRepository` validates git repository status, trunk branch existence, trunk head, and refuses dirty trunk by default.
- `createNodeWorktree` creates deterministic factory-owned branches and worktrees under a caller-provided worktree root.
- `commitNodeChanges` stages node changes, refuses empty commits, creates node commits with configured author metadata, and writes content-addressed diff artifacts when an artifact root is provided.
- `mergeNodeCommit` verifies expected node commit SHA and performs a root-scoped serial merge into trunk.
- `cleanupNodeWorktree` reads the factory sidecar marker and refuses unmarked or mismatched worktree cleanup.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/git-activities` passed.
- `npm test --workspace @durafoundry/git-activities` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged package diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: diff artifact paths initially used `Date.now()`, creating avoidable nondeterminism and possible path collisions.
- Fix: diff artifacts now use the SHA-256 of the diff content in the artifact path, with test coverage asserting a content-addressed patch URI.

Notes:

- Merge conflict behavior is not deeply handled yet; this chunk returns structured git command failures, and workflow-level retry/needs-human policy can consume those in later chunks.

### Chunk 0: Baseline Recheck

Status: complete.

Acceptance evidence:

- `git status --short --branch` showed a clean worktree on `main`, ahead only by local committed planning work before push.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` passed with no changed files to scan.

Notes:

- No code changes were needed for Chunk 0.
- `$fresh-eyes` skill was requested by the execution objective, but no `fresh-eyes` skill is installed in this Codex session. For code-writing chunks, perform a manual fresh-eyes review and record findings here unless that skill becomes available.

## Next Action

Start Chunk 3 from `docs/execution-plan-v0.md`: add the Temporal TypeScript workflow package and test harness with deterministic-safe workflow code and mocked Activities.
