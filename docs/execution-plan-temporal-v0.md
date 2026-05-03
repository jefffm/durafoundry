# DuraFoundry Temporal V0 Execution Plan

This plan picks up after `docs/execution-plan-v0.md` and `docs/v0-hardening-review.md`.
The prior plan produced a useful deterministic scaffold and local fixture demo, but it did not prove the system runs through a real Temporal Server, Worker, Client, Activities, Updates, and Queries.

The goal of this plan is narrow:

- Keep fake or fixture-backed agent Activities.
- Keep the generated fixture repository as the only supported target.
- Keep local filesystem artifacts.
- Keep root-scoped serial direct local merge.
- Make the existing v0 fixture flow execute through real Temporal.

Do not add Flue-backed agents, dashboard/API work, protected repository support, or a global merge queue in this plan unless a chunk explicitly says so.

## Execution Status

- Last completed chunk: Chunk 3, Activity Registration For Fixture Runtime.
- Next chunk: Chunk 4, Temporal CLI Worker And Client Path. Human review gate before starting.
- Progress log: `progress.md`.

## Operating Rules

For every chunk:

1. Start from a clean `main`.
2. Read `progress.md` before doing anything else. Treat it as memory across `/goal` runs.
3. Read this plan and the relevant parts of `docs/SPEC.md`, especially sections 6, 9, 11, 13.2, 15, 18.5, 19, and 24.
4. Keep writes inside the chunk's write scope unless a required shared contract change is discovered.
5. Add or update tests in the same chunk as behavior.
6. Run the chunk's validation commands.
7. Prefer running validation through the pinned Nix shell, for example `nix develop -c just validate`, whenever the command depends on Temporal, `just`, Node, npm, or other toolchain binaries.
8. Run a `$fresh-eyes` review after writing code. Fix every finding before moving to the next chunk. If the `$fresh-eyes` skill is unavailable in the current Codex session, perform a manual equivalent review and record that fact in `progress.md`.
9. Update `progress.md` with:
   - chunk status
   - acceptance evidence
   - validation evidence
   - `$fresh-eyes` findings and fixes
   - next chunk
10. Update this plan's Execution Status after each chunk.
11. Commit and push `main` after each completed chunk.
12. Do not mark a chunk complete if acceptance criteria are only partially met.

## Autonomous Queue Policy

This plan is intended to run under Codex `/goal` in a risk-based autonomous queue.
The agent may continue from one chunk to the next without waiting for human approval only when all of these conditions are true:

- The chunk completed exactly against its acceptance criteria.
- The worktree is clean after commit and push.
- All validation commands for the chunk passed.
- `$fresh-eyes` or a manual equivalent review found no unresolved issues.
- `progress.md` and this plan both identify the next chunk.
- The next chunk is not listed as a human review gate below.

Stop immediately and report status instead of continuing when:

- A validation command fails and the fix is not obvious within the current chunk scope.
- A review or judge finding identifies a product, safety, data-loss, or architecture risk.
- A required change falls outside the current chunk's write scope.
- Temporal test infrastructure cannot run honestly in the local environment.
- The implementation would need to target a non-fixture repository.
- The next chunk is a human review gate.

Human review gates:

- Before Chunk 4, because it replaces the CLI's direct scaffold path with real Temporal Client/Worker orchestration.
- Before Chunk 7, because it declares final Temporal-backed fixture acceptance and updates the hardening review.
- After Chunk 7, before starting any work outside this plan.

Suggested autonomous `/goal` prompt:

```text
/goal Execute docs/execution-plan-temporal-v0.md as a risk-based autonomous queue. Start at the Next chunk recorded in docs/execution-plan-temporal-v0.md and progress.md. For each chunk, read progress.md first, execute only that chunk's write scope and acceptance criteria, run its validation commands preferably through nix develop where toolchain binaries are involved, run $fresh-eyes or a manual equivalent if unavailable, fix every finding, update progress.md and docs/execution-plan-temporal-v0.md, commit and push main, then continue to the next chunk only if the Autonomous Queue Policy allows it. Stop and report status before any human review gate, unresolved validation failure, out-of-scope change, or dishonest Temporal test shortcut.
```

The most important invariant:

> The fixture demo must prove Temporal owns orchestration. The CLI may create the fixture repo and submit approvals, but it must not execute the DAG by calling scaffold functions directly.

## Current Baseline

Already implemented:

- `@durafoundry/domain`: Valibot schemas and semantic validation.
- `@durafoundry/artifact-store`: local filesystem artifacts and plan bundles.
- `@durafoundry/fixture-repo`: generated disposable git repository.
- `@durafoundry/git-activities`: real git worktree, commit, merge, and cleanup functions.
- `@durafoundry/fake-agent-activities`: fake planner, coder, reviewer, judge, broad gates, and gap planner.
- `@durafoundry/workflows`: deterministic scaffold plus initial Temporal workflow wrappers.
- `@durafoundry/cli`: local fixture demo that currently runs the deterministic scaffold directly.
- `flake.nix`, `.envrc`, and `Justfile`: pinned Nix development shell and local Temporal CLI smoke recipes.

Known gap:

- The current CLI does not connect to Temporal.
- There is no Worker process.
- There is no Temporal Client startup path.
- `FactoryRunWorkflow` currently waits for plan approval and returns; it does not execute the approved DAG through Temporal.

Baseline validation:

```bash
nix flake check
nix develop -c just smoke-temporal-cli
nix develop -c just validate
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
git status --short --branch
```

## Chunk 0: Nix Temporal Environment Baseline

Goal prompt:

```text
/goal Start the Temporal v0 runtime plan by validating the pinned Nix development shell. Read progress.md, docs/SPEC.md, docs/v0-hardening-review.md, README.md, flake.nix, Justfile, and docs/execution-plan-temporal-v0.md. Confirm the current repo is clean, confirm the Nix shell provides Node/npm/just/temporal, confirm the Temporal CLI smoke recipe starts and stops a local dev server, confirm the CLI still uses the deterministic scaffold directly, confirm no Temporal Client/Worker dependency exists, run baseline validation, and update progress.md with the starting state. Make no code changes except progress/plan/bookkeeping unless baseline validation is broken.
```

Write scope:

- `progress.md`
- `docs/execution-plan-temporal-v0.md`
- `flake.nix`
- `flake.lock`
- `.envrc`
- `Justfile`
- `.gitignore`
- `README.md`
- No code unless baseline validation is broken.

Acceptance:

- `progress.md` records this plan as active.
- `flake.nix` defines the canonical dev shell.
- `.envrc` uses the flake.
- `Justfile` includes at least:
  - `validate`
  - `smoke-temporal-cli`
  - `temporal-dev`
- `nix develop -c temporal operator cluster health --address 127.0.0.1:7233 --namespace default` is not required to pass without a server, but the `temporal` binary must exist inside the shell.
- `just smoke-temporal-cli` starts an isolated Temporal dev server, waits until it is healthy, probes `temporal workflow list`, and shuts the server down.
- `README.md` documents entering the shell and using the Temporal recipes.
- Baseline validation passes or failures are diagnosed.
- The current Temporal gap is explicitly recorded:
  - no Worker process
  - no Client process
  - CLI calls scaffold directly
  - live Temporal execution is untested
- Worktree is clean before moving to Chunk 1.

Validation:

```bash
git status --short --branch
nix flake check
nix develop -c just smoke-temporal-cli
nix develop -c just validate
```

## Chunk 1: Temporal Dependencies And Test Harness

Goal prompt:

```text
/goal Add the minimal Temporal runtime dependencies and a real Temporal test harness. The workflow package should keep workflow code deterministic, but tests must be able to start a Temporal test environment, create a Worker, register fake/git Activities, start a Workflow, send an Update, query state, and await completion.
```

Write scope:

- `packages/workflows/**`
- `package.json`
- `package-lock.json`
- `tsconfig.base.json` only if required
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Add `@temporalio/client`, `@temporalio/worker`, and `@temporalio/testing` where appropriate.
- Keep `@temporalio/workflow` as the only Temporal package imported by workflow code.
- Add a test helper that can:
  - create a Temporal test environment
  - create a Worker for a unique task queue
  - register Activities
  - start a workflow
  - issue Updates
  - issue Queries
  - wait for a result
  - shut down cleanly
- Keep test environment setup out of workflow code.
- If `@temporalio/testing` cannot run in this environment, stop and record the blocker instead of faking success.

Acceptance:

- A smoke test starts a trivial existing workflow on a real Temporal test environment.
- The test sends at least one Update and reads at least one Query from Temporal, not from direct function calls.
- Workflow package still builds without Node-only imports in workflow code.
- Test teardown leaves no running Worker or hanging process.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows -- --test-name-pattern "temporal|worker|client|update|query"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 2: Real FactoryRunWorkflow End-To-End State Machine

Goal prompt:

```text
/goal Make FactoryRunWorkflow execute the v0 fixture run after plan approval. The workflow should create a draft plan through an Activity, wait for plan approval through a Temporal Update, then execute the approved DAG through Activity proxies, update queryable run state, and complete with node commits, merge commits, cleanup, milestone gates, and final status.
```

Write scope:

- `packages/workflows/**`
- `packages/domain/**` only for missing runtime state contracts
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Extend `FactoryRunInput` or add a new input type with the runtime data needed by the workflow:
  - run id
  - spec URI/hash
  - artifact root
  - fixture repo path
  - trunk branch
  - worktree root
  - git author
- `FactoryRunWorkflow` must:
  - call planner Activity
  - store draft plan refs in queryable state
  - wait for `approvePlan` Update
  - reject stale approval
  - execute the DAG after approval
  - expose status changes through Query
  - return final run state
- Side effects must remain in Activities.
- Do not call Node filesystem, git, fixture, or fake-agent code from workflow code.
- Keep the deterministic scaffold as a shared pure helper only if it remains safe in workflow execution.

Acceptance:

- Temporal integration test starts `FactoryRunWorkflow` with mocked Activities and reaches `waiting_for_plan_approval`.
- The test approves the plan through a real Temporal Update and observes status transition to DAG execution.
- The workflow completes after mocked DAG execution.
- Query state is correct before approval, during execution, and after completion.
- Direct calls to `runFactoryRunScaffold` are not the test's main assertion path.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows -- --test-name-pattern "factory|temporal|approval|dag"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 3: Activity Registration For Fixture Runtime

Goal prompt:

```text
/goal Build the real Activity registration layer for the Temporal fixture runtime. Register fake planner/coder/reviewer/judge/broad-gate Activities and real git worktree/commit/merge/cleanup Activities under names that FactoryRunWorkflow can call through typed proxies.
```

Write scope:

- `packages/workflows/**` or a new `packages/temporal-runtime/**`
- `apps/cli/**` only for shared Activity wiring imports if needed
- Workspace metadata
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Provide a reusable function that returns the Activity implementation map for a fixture run.
- Activity names must match the workflow proxy contracts.
- Activity implementations must wrap:
  - `runFakePlanner`
  - `runFakeCoder`
  - fake verification command result for fixture mode
  - `commitNodeChanges`
  - `runFakeReviewer`
  - `runFakeJudge`
  - `mergeNodeCommit`
  - `cleanupNodeWorktree`
  - `runFakeBroadReviewer`
  - `runFakeBroadJudge`
- Activity inputs and outputs must remain structured and serializable.
- Git and artifact paths must come from workflow input or Activity input, not hidden globals.
- No Activity should target the DuraFoundry implementation checkout.

Acceptance:

- Temporal integration test registers the real fixture Activity map.
- The workflow starts, waits for plan approval, receives approval through Update, executes at least one node through real Activity implementations, and completes.
- Test proves a generated fixture repo was used.
- Test proves real git commits and merge commits exist on the fixture repo.
- Test proves cleanup removed factory worktrees.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows -- --test-name-pattern "activity|fixture|git|temporal"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 4: Temporal CLI Worker And Client Path

Goal prompt:

```text
/goal Replace the CLI scaffold execution path with a real Temporal Client/Worker fixture path. The CLI should create the fixture repo, start a local Worker for the fixture Activities when requested, start FactoryRunWorkflow, submit plan approval when --auto-approve is set, query/observe the workflow, and print the final JSON result.
```

Write scope:

- `apps/cli/**`
- `packages/workflows/**` or `packages/temporal-runtime/**` for shared runtime helpers
- Workspace metadata
- `README.md`
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Add CLI flags:
  - `--temporal-address <host:port>`
  - `--task-queue <name>`
  - `--auto-approve`
  - `--start-worker`
  - `--allow-needs-human`
  - `--preserve-fixture`
- Default Temporal address should be `TEMPORAL_ADDRESS` or `localhost:7233`.
- CLI must fail fast with a clear error if Temporal is unavailable and `--start-worker` cannot proceed.
- CLI must not silently fall back to direct scaffold execution.
- CLI may start an in-process Worker for v0 fixture/demo mode, but the workflow execution must still go through Temporal Client/Worker APIs.
- Auto approval must call a Temporal Update.
- CLI JSON output must include:
  - run id
  - workflow id
  - task queue
  - Temporal address
  - artifact root
  - fixture repo path
  - plan id
  - DAG id
  - snapshot id
  - node commits
  - merge commits
  - final status
- README must document how to run Temporal locally and how to run the fixture CLI.

Acceptance:

- CLI tests no longer assert direct scaffold execution.
- CLI test with Temporal test environment starts the CLI path, auto-approves through Temporal Update, and completes.
- CLI rejects missing `--fixture-repo`.
- CLI rejects unknown flags.
- CLI fails clearly when Temporal is unavailable.
- CLI does not mutate the implementation checkout.

Validation:

```bash
npm run typecheck --workspace @durafoundry/cli
npm test --workspace @durafoundry/cli
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 5: Temporal Updates, Queries, Pause, And Human Control

Goal prompt:

```text
/goal Prove the interactive control surface works against a real Temporal Workflow. Add integration tests for plan approval, stale approval rejection, pause, resume, cancel node, request follow-up DAG, approve follow-up DAG, retry/skip-delay rejection behavior, and query state.
```

Write scope:

- `packages/workflows/**`
- `apps/cli/**` only if CLI helpers need query/update support
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Updates must run inside a real Temporal workflow execution:
  - `approvePlan`
  - `rejectPlan`
  - `requestPlanChanges`
  - `pauseRun`
  - `resumeRun`
  - `cancelNode`
  - `overrideGate`
  - `requestFollowupDag`
  - `approveFollowupDag`
  - `retryFromState`
  - `skipDelay`
- Query state must show:
  - current run status
  - plan refs
  - approved snapshot refs
  - node summaries
  - latest failure reason
  - paused state
  - follow-up DAG state when present
- The workflow must not launch new nodes while paused.
- Stale approvals must be rejected by the Update, not merely ignored in local state.

Acceptance:

- Temporal integration tests call Updates through Temporal Client handles.
- Tests assert accepted/rejected Update results.
- Tests assert Query output before and after each control action.
- Pause/resume semantics work while the workflow is waiting and while it is executing.
- Human follow-up DAG request can stop scheduling and expose a pending approval state.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows -- --test-name-pattern "update|query|pause|resume|followup|temporal"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 6: Temporal Cancellation, Cleanup, And Failure Semantics

Goal prompt:

```text
/goal Harden real Temporal cancellation and failure behavior. A cancelled or failed node/run must clean up factory-owned worktrees where possible, preserve artifacts, surface structured failure reasons, and never leave the run falsely completed.
```

Write scope:

- `packages/workflows/**`
- `packages/git-activities/**` only for missing cleanup/failure contracts
- `packages/domain/**` only for missing status fields
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Workflow cancellation or node terminal failure schedules cleanup for created worktrees.
- Cleanup failures are recorded, not swallowed.
- Merge failure is represented as structured state, not an unclassified thrown error where avoidable.
- Workflow returns `needs_human` or `failed` when cleanup/merge/failure policy requires it.
- No test leaves fixture worktrees or branches behind unless the test intentionally preserves them for inspection.

Acceptance:

- Temporal integration test cancels a run after a worktree is created and asserts cleanup behavior.
- Test simulates Activity failure during merge and asserts the run does not complete.
- Test simulates cleanup failure and asserts the failure is queryable.
- Test proves non-factory cleanup is still refused.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows -- --test-name-pattern "cancel|cleanup|failure|merge|temporal"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 7: Temporal Fixture Acceptance

Goal prompt:

```text
/goal Add final Temporal-backed v0 fixture acceptance coverage. The acceptance run must use a generated fixture repository, local artifact root, real Temporal Client and Worker, plan approval Update, query observation, fake agent Activities, real git Activities, node repair, serial merge, cleanup, milestone gates, and final CLI JSON output.
```

Write scope:

- `apps/cli/**`
- `packages/workflows/**`
- `test/**` if a top-level acceptance test layout is introduced
- `README.md`
- `docs/v0-hardening-review.md`
- `progress.md`
- `docs/execution-plan-temporal-v0.md`

Required behavior:

- Acceptance test starts a real Temporal environment.
- Acceptance test starts a Worker with fixture Activities.
- Acceptance test starts the CLI or the same Client code the CLI uses.
- At least one node fails once and repairs before merge.
- At least two nodes merge serially.
- Milestone gates run.
- Artifacts are asserted, not merely produced.
- Query output is sampled during the run.
- Final CLI JSON is machine-readable and complete.
- No test mutates the DuraFoundry implementation checkout as target repo.

Acceptance:

- This command succeeds:

```bash
npm test --workspace @durafoundry/cli -- --test-name-pattern "temporal|acceptance|fixture"
```

- Full workspace validation succeeds.
- `docs/v0-hardening-review.md` is updated to say the Temporal runtime gap is closed.
- `README.md` contains accurate Temporal fixture demo instructions.

Validation:

```bash
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
git status --short --branch
```

## Completion Definition

This plan is complete when:

- The CLI fixture run goes through a real Temporal Client and Worker.
- The CLI no longer calls `executeDagScaffold` directly for the production demo path.
- `FactoryRunWorkflow` executes beyond plan approval into DAG execution.
- Plan approval is submitted through a Temporal Update.
- Queries expose useful live run state.
- The Worker registers real fixture Activity implementations.
- The fixture run creates real git worktrees, node commits, serial merges, cleanup, and artifacts.
- Tests prove all of the above with a Temporal test environment or a documented local Temporal Server.
- Full workspace typecheck, tests, audit, and UBS diff pass.

## Explicitly Deferred

These are still not part of this plan:

- Real Flue-backed planner/coder/reviewer/judge Activities.
- Production protected repository support.
- Branch-and-PR mode.
- Repo/trunk-scoped global merge queue across concurrent factory runs.
- HTTP API.
- Web dashboard.
- GitHub artifact publishing.
- Hosted multi-user credential storage.
