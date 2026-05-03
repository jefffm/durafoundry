# DuraFoundry v0 Progress

This file is the handoff point for iterative `/goal` execution. Read it at the beginning of each turn before choosing the next chunk.

## Current State

- Last completed chunk: Chunk 5, Node Execution Repair Loop.
- Next chunk: Chunk 6, DAG Scheduler And Merge Queue.
- Current branch: `main`.
- Last validation date: 2026-05-03.

## Chunk Log

### Chunk 5: Node Execution Repair Loop

Status: complete.

Acceptance evidence:

- Added typed `NodeExecutionActivities` and `nodeExecutionWorkflow` entry point without importing Node-only Activity implementations into workflow code.
- Added deterministic `executeNodeScaffold` behavior for one node: dependency readiness check, worktree creation, fake coder Activity call, local verification, checkpoint commit, reviewer gate, judge gate, node-local repair loop, and terminal max-attempt escalation.
- Node attempt records include changed files, command results, verification results, diff URI, checkpoint commits, commit SHA, review report, judge report, and repair instructions.
- Node run history records attempt ids, review report ids, judge report ids, repair instructions, and the final gated commit SHA when ready to merge.
- Verification, review, and judge failures repair the same node when repair instructions are node-local.
- Out-of-scope findings and failed gates without repair instructions escalate to `needs_human` without appending graph work.
- Tests cover pass-first-time, reviewer fail then repair pass, judge fail then repair pass, verification fail then repair pass, all configured verification commands, max-attempt escalation, out-of-scope review escalation, missing repair instructions, and dependency blocking.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows -- --test-name-pattern "node|repair|judge|review"` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged workflow and progress diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the first implementation would have looped on a failed gate that returned no repair instructions.
- Fix: failed gates now require at least one node-local repair instruction to continue repair; otherwise the node escalates to `needs_human`.
- Finding: verification initially ran only the first command even though plan nodes carry an array of verification commands.
- Fix: the node loop now runs every configured verification command until one fails, and test coverage asserts both commands are recorded.

### Chunk 4: Plan Approval And Snapshot Execution

Status: complete.

Acceptance evidence:

- Draft plan results are validated with `validatePlanDAG` and `validatePlanSnapshotManifest` before entering approval.
- Workflow state stores bounded plan and snapshot refs: plan id, DAG id, artifact URI/hash, snapshot id, manifest URI/hash, and summary.
- Plan approval rejects stale inputs when the plan id, artifact URI, or artifact hash no longer matches the current draft.
- Approved plans create a frozen `approvedSnapshot` ref and transition the run to `executing_dag`.
- Reject and request-changes updates remain explicit plan decisions.
- Tests cover approval, rejection, change request, stale artifact rejection, stale plan-id rejection, invalid graph rejection, invalid snapshot manifest rejection, bounded snapshot refs, and approved snapshot immutability.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows -- --test-name-pattern "plan|snapshot|approval"` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged package and progress diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the first Chunk 4 test set covered stale artifact mismatches but did not explicitly cover stale plan-id mismatches, and snapshot immutability was implied by `Object.freeze` without a regression assertion.
- Fix: added explicit stale plan-id, bad snapshot manifest, and frozen snapshot mutation assertions before completing the chunk.

### Chunk 3: Temporal Workflow Scaffold

Status: complete.

Acceptance evidence:

- Added `@durafoundry/workflows`.
- Defined deterministic-safe workflow contracts in `contracts.ts`.
- Added `factoryRunWorkflow` with typed Temporal Activity proxy, query handler, and scaffold Update handlers for plan approval/rejection/change request, pause/resume, cancel node, gate override, retry from state, skip delay, and human follow-up DAG request.
- Added a deterministic scaffold harness in `scaffold.ts` that mirrors workflow state transitions without needing Temporal client/worker test dependencies.
- Tests verify a mocked factory run reaches `waiting_for_plan_approval`, exposes stable state, approves a matching plan, pauses, records human follow-up DAG requests, and rejects approval when not waiting.
- Workflow code imports only `@temporalio/workflow`, domain types, and deterministic local scaffold helpers; Node-only test code is not imported by workflow code.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged package diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: using Temporal client/worker/testing packages introduced an unfixed moderate `uuid` advisory through `@temporalio/client`.
- Fix: switched tests to the allowed deterministic workflow harness path and kept runtime workflow code dependent only on `@temporalio/workflow`, restoring `npm audit` to 0 vulnerabilities.

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

Start Chunk 6 from `docs/execution-plan-v0.md`: implement DAG scheduling, dependency readiness, parallelism limits, milestone ordering, and the root-scoped serial merge queue.
