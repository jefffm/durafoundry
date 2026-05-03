# V0 Hardening Review

Date: 2026-05-03

## Result

The implemented v0 execution-plan slice is usable for the local fixture path:

- `durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry` runs against a generated fixture repository.
- Plan bundles and immutable snapshot manifests are written to local filesystem artifacts.
- Nodes execute through fake planner/coder/reviewer/judge Activities and real git worktrees, commits, serial merges, and cleanup.
- Node-local verification/review/judge failures repair the same node before merge.
- Human follow-up DAG request, selective cancellation/skipping, approval, and resume are covered.
- Full workspace typecheck, tests, audit, and UBS diff checks pass.

## Blocking Fixes Applied

1. Milestone gap reports no longer produce false successful runs.

   Broad milestone review/judge gates can produce `GapReport`s. Before this review, the DAG scaffold recorded those reports but still marked the run `completed`. The scheduler now stops at `needs_human` with the gap reports attached, which preserves the v0 rule that new graph work must happen through milestone/final/human follow-up rather than silently completing.

2. Pause/resume now preserves the exact pause boundary.

   `pauseRunState` recorded `statusBeforePause` after setting `paused`, which could lose the exact state being paused. It now records the prior status first, and regression coverage proves a plan-approval pause resumes to `waiting_for_plan_approval`.

## Review Checklist

- SPEC acceptance criteria: covered for the fixture execution-plan slice; broader Temporal runtime and Flue-backed agent work remain deferred below.
- Workflow determinism: workflow code imports only `@temporalio/workflow`, domain types, and deterministic scaffold helpers.
- Side effects: git, filesystem artifacts, fixture repository creation, and fake agent effects live outside workflow code.
- Git safety: fixture/local repository paths are guarded; dirty trunk and unmarked cleanup are rejected.
- Snapshot immutability: approved snapshot refs are frozen and stale approval is rejected.
- Node repair: node-local failures repair the same node and out-of-scope/no-instruction failures escalate to `needs_human`.
- Graph mutation: running graph is not patched; milestone gap reports now stop the line, and human follow-up DAG control is explicit.
- Merge queue: root-scoped merge remains serial and FIFO within one run.
- Cleanup: worktrees are cleaned after merge and cleanup refuses non-factory markers.
- CLI safety: v0 CLI requires `--fixture-repo` and targets generated repositories, not the implementation checkout.
- Security/dependencies: `npm audit` reports 0 vulnerabilities.

## Nonblocking Next Steps

1. Add a real local Temporal worker/client demo path.

   The current CLI uses the deterministic scaffold directly. That is enough for the execution-plan fixture slice, but it does not satisfy the broader SPEC section 18.5 goal that the CLI talk to a local Temporal Server and fail clearly when Temporal is unavailable.

2. Execute approved follow-up DAGs, not just approve and resume control state.

   Human follow-up DAG creation and approval are modeled, and broad milestone gaps now stop the run. The next step is wiring approved follow-up DAG execution into the scheduler.

3. Add automatic broad-gap planning behind an Activity boundary.

   `runFakeGapPlanner` can convert a `GapReport` into a follow-up `PlanDAG`, but the DAG scaffold does not yet call a gap planner when milestone/final gates fail.

4. Add real Flue-backed agent Activities.

   Fake Activities intentionally preserve the contract shape. The next integration should use `packages/flue-runtime` for planner/coder/reviewer/judge roles while keeping OAuth tokens out of prompts, transcripts, artifacts, and workflow state.

5. Add production repository modes.

   V0 direct local merge is limited to trusted fixture/local repositories. Protected or shared repositories still need branch-and-PR mode and a repo/trunk-scoped global merge queue.

