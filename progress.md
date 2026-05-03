# DuraFoundry v0 Progress

This file is the handoff point for iterative `/goal` execution. Read it at the beginning of each turn before choosing the next chunk.

## Current State

- Active plan: `docs/execution-plan-temporal-v0.md`.
- Last completed chunk: Temporal V0 Chunk 1, Temporal Dependencies And Test Harness.
- Next chunk: Temporal V0 Chunk 2, Real FactoryRunWorkflow End-To-End State Machine.
- Current branch: `main`.
- Last validation date: 2026-05-03.

## Chunk Log

### Temporal V0 Chunk 1: Temporal Dependencies And Test Harness

Status: complete.

Acceptance evidence:

- Added `@temporalio/client`, `@temporalio/worker`, and `@temporalio/testing` to the workflow workspace.
- Added a Node-side Temporal test harness that starts a local Temporal test environment using the Nix-provided `temporal` CLI.
- The harness creates a Worker with a unique task queue, registers Activity implementations, starts workflows through a Temporal Client, supports Updates and Queries through workflow handles, and tears down the server after the Worker drains.
- Added a real Temporal smoke test that starts `factoryRunWorkflow`, waits for `waiting_for_plan_approval` through a Query, approves the plan through the `approvePlan` Update, and awaits the workflow result.
- Verified workflow implementation files still only import `@temporalio/workflow`; Node-only Temporal packages are isolated to the test harness and tests.
- Overrode Temporal's transitive `uuid` dependency to `14.0.0` so `npm audit` remains clean, then proved the SDK still works with the real Temporal smoke test.

Validation evidence:

- `nix develop -c npm run typecheck --workspace @durafoundry/workflows` passed.
- `nix develop -c npm test --workspace @durafoundry/workflows -- --test-name-pattern "temporal|worker|client|update|query"` passed, including the real Temporal Worker/Client smoke test.
- `nix develop -c bash -lc 'npm run typecheck --workspaces --if-present && npm test --workspaces --if-present && npm audit && npm run ubs:diff'` passed.
- `npm audit` passed with 0 vulnerabilities after the `uuid` override.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: installing the latest Temporal JS SDK introduced a moderate `uuid` advisory through `@temporalio/client`.
- Fix: added a root npm override for `@temporalio/client@1.17.0` to use `uuid@14.0.0`, reran install/audit, and validated the SDK with the real Temporal smoke test.
- Finding: `@temporalio/testing` was initially installed as a runtime dependency.
- Fix: moved `@temporalio/testing` to workflow devDependencies.
- Finding: workflow determinism could be compromised if Client/Worker imports leaked into workflow code.
- Fix: verified the deterministic workflow files do not import `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, or Node built-ins.

### Temporal V0 Autonomous Queue Setup

Status: complete.

Acceptance evidence:

- Added an Autonomous Queue Policy to `docs/execution-plan-temporal-v0.md`.
- The policy allows Codex `/goal` to continue chunk-by-chunk after clean validation, clean review, committed progress, and pushed `main`.
- The policy requires a stop instead of continuing when validation fails, review finds unresolved risk, work falls outside scope, Temporal cannot be tested honestly, or work would target a non-fixture repository.
- Human review gates are explicit before Chunk 4, before Chunk 7, and after Chunk 7.
- Added a reusable autonomous `/goal` prompt to the plan.

Validation evidence:

- Documentation-only change.
- `git diff --check` passed before commit.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: without explicit gates, an autonomous `/goal` could replace CLI orchestration or declare final acceptance without human review.
- Fix: the plan now defines mandatory stop points before Chunk 4 and Chunk 7.

### Temporal V0 Chunk 0: Nix Temporal Environment Baseline

Status: complete.

Acceptance evidence:

- Confirmed `main` was clean before starting the Temporal V0 plan bookkeeping.
- Added and pushed the pinned Nix development shell in commit `0b993df Add Nix Temporal development shell`.
- `flake.nix` defines the canonical dev shell with Node.js, npm, `just`, `temporal`, `jq`, `git`, and `rg`.
- `.envrc` uses the flake.
- `Justfile` includes `validate`, `smoke-temporal-cli`, and `temporal-dev`.
- `just smoke-temporal-cli` starts an isolated local Temporal dev server, waits for health, probes `temporal workflow list`, and shuts it down.
- `README.md` documents entering the shell and using the Temporal recipes.
- Confirmed the current CLI still runs the deterministic scaffold directly.
- Confirmed the current Temporal runtime gaps:
  - no Worker process
  - no Client process
  - CLI calls scaffold directly
  - live Temporal execution is untested

Validation evidence:

- `nix flake check` passed.
- `nix develop -c just smoke-temporal-cli` passed.
- `nix develop -c just validate` passed.
- `npm run typecheck --workspaces --if-present` passed inside `just validate`.
- `npm test --workspaces --if-present` passed inside `just validate`.
- `npm audit` passed with 0 vulnerabilities inside `just validate`.
- `npm run ubs:diff` completed inside `just validate`.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: `progress.md` still pointed at the completed deterministic v0 plan, which would make the next `/goal` ambiguous.
- Fix: `progress.md` now marks `docs/execution-plan-temporal-v0.md` active and points the next chunk at Temporal V0 Chunk 1.
- Finding: `docs/execution-plan-temporal-v0.md` still marked Chunk 0 as next even though the Nix/Temporal baseline was already implemented and validated.
- Fix: the Temporal plan status now marks Chunk 0 complete and Chunk 1 next.

### Chunk 10: Spec Review And Hardening

Status: complete.

Acceptance evidence:

- Reviewed the implemented v0 fixture slice against `docs/SPEC.md` and `docs/execution-plan-v0.md`.
- Fixed a blocking false-success bug where milestone broad gates could emit gap reports while the DAG scaffold still marked the run `completed`.
- Fixed `pauseRunState` so pause/resume preserves the exact pre-pause status boundary.
- Added regression coverage for milestone gap reports stopping the line at `needs_human`.
- Added regression coverage for pausing during plan approval and resuming back to `waiting_for_plan_approval`.
- Added `docs/v0-hardening-review.md` with the review result, applied blocking fixes, checklist status, and nonblocking next steps.
- Linked the hardening review from `README.md`.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged hardening diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the scheduler treated broad-gate gap reports as informational while still completing the run.
- Fix: broad-gate gap reports now stop the line at `needs_human`, preserving explicit follow-up DAG control.
- Finding: pause state bookkeeping could lose the exact status being paused.
- Fix: pause state records the prior status before marking the run paused.

Nonblocking next steps:

- Add a real local Temporal worker/client demo path; the current CLI uses the deterministic scaffold directly.
- Execute approved follow-up DAGs after approval rather than only modeling the control state.
- Wire automatic broad-gap planning through an Activity boundary.
- Replace fake agent Activities with Flue-backed Activities using `packages/flue-runtime`.
- Add branch-and-PR mode and a repo/trunk-scoped global merge queue before shared/protected repository use.

### Chunk 9: End-To-End Fixture Acceptance

Status: complete.

Acceptance evidence:

- Added CLI-level v0 acceptance coverage for the full fixture run using a generated repository and local artifact root.
- The E2E run covers plan approval, immutable snapshot refs, plan and snapshot artifact readability, DAG scheduling, real git worktrees, real git node commits, serial merge, cleanup, milestone broad review, and milestone broad judge.
- The `fixture-alpha` node fails review on the first attempt, repairs on the same node, and then merges; `fixture-beta` also merges, proving at least two nodes merge serially.
- The test asserts merge concurrency stays at 1, both cleanup results remove factory worktrees, artifact URIs for diffs and agent sessions are readable, and the fixture repo path is outside the DuraFoundry checkout.
- A separate acceptance scenario exercises a human follow-up DAG request, durable pause, selected node cancellation, approval, and resume.
- A CLI E2E scenario runs `durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root <tmp>` against a generated fixture repository and asserts completed JSON output.
- Test logs identify artifact roots and fixture repo paths, for example `/tmp/durafoundry-e2e-QQQnfx/fixtures/e2e-repair/repo` and `/tmp/durafoundry-e2e-cli-x2qBCw/fixtures/run-43514ee0-3951-4185-b054-d92ac2878cd4/repo`.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/cli` passed.
- `npm test --workspace @durafoundry/cli` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged E2E test and progress/plan diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the first E2E state setup built the SPEC URI with string concatenation.
- Fix: the E2E test now uses `pathToFileURL(...).href`, matching the CLI fix from Chunk 8 and avoiding path encoding bugs.

### Chunk 8: CLI Demo Path

Status: complete.

Acceptance evidence:

- Added `@durafoundry/cli` with `durafoundry` bin metadata and the command shape `durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry`.
- The CLI requires `--fixture-repo`, creates a generated disposable fixture repository under the artifact root, and does not target the DuraFoundry implementation checkout.
- The CLI reads the SPEC, writes a fake planner plan/snapshot bundle, auto-approves the plan for the demo path, runs the deterministic DAG scaffold with fake agents and real git worktree/commit/merge/cleanup Activities, and waits for completion.
- The CLI prints one machine-readable JSON object containing run id, workflow id, artifact root, fixture repo path, plan id, DAG id, snapshot id, node commit SHAs, merge commit SHAs, and final status.
- The CLI exits nonzero for failure or `needs_human` terminal states unless `--allow-needs-human` is passed.
- README documents the demo command and the safety boundary that v0 only runs against generated fixture repositories.
- CLI smoke test executes the built CLI with a temp artifact root, asserts JSON output shape, asserts final status is `completed`, and asserts the fixture repo path is outside the DuraFoundry checkout.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/cli` passed.
- `npm test --workspace @durafoundry/cli` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged CLI, README, package metadata, and progress diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the first CLI implementation built the SPEC URI with string concatenation.
- Fix: SPEC artifact metadata now uses `pathToFileURL(specPath).href`, which handles absolute paths safely.

### Chunk 7: Human Follow-Up DAG Control

Status: complete.

Acceptance evidence:

- `requestFollowupDagState` accepts `HumanGapRequest`, durably pauses scheduling, records the requested gap, and preserves the prior status for resume.
- Follow-up control now cancels only explicitly selected unmerged nodes and skips only explicitly selected unstarted nodes.
- Merged node summaries are left untouched and frozen when selected for cancellation.
- Follow-up DAG drafts are validated as plan/snapshot artifacts, must reference the active parent DAG and parent snapshot, and are stored as bounded refs in `state.followupDag`.
- Approval policy supports `always`, `high-risk-only`, `never`, and explicit human override; high-risk follow-up nodes require approval under `high-risk-only`.
- Added `approveFollowupDagState` and `approveFollowupDagUpdate` for stale-safe follow-up DAG approval.
- `resumeRunState` returns paused execution to its previous durable status, allowing approved follow-up control to resume legal original scheduling.
- Tests cover pause-only, pause plus selective cancel/skip, follow-up DAG approval, high-risk approval requirement, resume, stale approval rejection, and preservation of unselected active/ready nodes.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows -- --test-name-pattern "followup|gap|pause|resume|cancel"` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged workflow and progress diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: follow-up control could easily overreach by mutating unselected nodes or completed work.
- Fix: tests now assert unselected active/ready nodes remain unchanged and merged nodes remain immutable even if included in a cancellation request.

### Chunk 6: DAG Scheduler And Merge Queue

Status: complete.

Acceptance evidence:

- Added typed DAG execution contracts and a `dagExecutionWorkflow` entry point.
- Added deterministic `executeDagScaffold` behavior that schedules ready nodes from the approved snapshot, respects dependency edges, enforces `maxActiveNodes`, enforces `maxActiveHighRiskNodes`, and schedules only the first unfinished milestone.
- Ready-to-merge nodes enter a root-scoped serial merge loop; observed merge concurrency is recorded and remains 1.
- Merged nodes are marked `merged` and their state summaries are frozen so later scheduler passes do not reschedule or mutate them.
- Worktrees are cleaned after merge, and terminal node failures trigger durable cleanup when a worktree was created.
- Milestone broad review and broad judge gates run after all nodes in a milestone have merged.
- The real fixture integration test runs two independent fixture nodes, uses real git worktree/commit/merge/cleanup Activities, verifies serial merge order, and verifies fixture trunk contains both node changes.
- Tests cover dependency blocking, high-risk throttling, total parallelism, milestone ordering, serial merge behavior, cleanup, and milestone gates.

Validation evidence:

- `npm run typecheck --workspace @durafoundry/workflows` passed.
- `npm test --workspace @durafoundry/workflows -- --test-name-pattern "dag|scheduler|merge|milestone"` passed.
- `npm run typecheck --workspaces --if-present` passed.
- `npm test --workspaces --if-present` passed.
- `npm audit` passed with 0 vulnerabilities.
- `npm run ubs:diff` scanned the staged workflow, package metadata, and progress diff with 0 warnings and 0 critical issues.

Fresh-eyes review:

- `$fresh-eyes` is not installed in this Codex session, so a manual fresh-eyes review was performed.
- Finding: the first scheduler pass respected dependencies and parallelism but could schedule nodes from later milestones when no explicit edge blocked them.
- Fix: ready-node selection is now constrained to the first unfinished milestone, with regression coverage proving milestone 2 waits for milestone 1 to merge and run its gates.

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

All planned v0 execution chunks are complete. Next work should start from the nonblocking next steps in `docs/v0-hardening-review.md`.
