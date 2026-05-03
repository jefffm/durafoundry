# DuraFoundry v0 Execution Plan

This plan is meant to be executed one chunk at a time with Codex `/goal`.
Each chunk should produce one reviewable commit unless the chunk explicitly says it is a planning or validation-only pass.

## Execution Status

- Last completed chunk: Chunk 2, Fake Agent Activities.
- Next chunk: Chunk 3, Temporal Workflow Scaffold.
- Progress log: `progress.md`.

## Operating Rules

For each chunk:

1. Start from a clean `main`.
2. Read the current `docs/SPEC.md`, this file, and the packages touched by the chunk.
3. Keep writes inside the listed write scope unless a required shared contract change is discovered.
4. Add or update tests in the same chunk as the behavior.
5. Run the listed validation commands.
6. Commit only when validation passes.
7. Stop and report if the chunk reveals a spec gap, unsafe repository mutation path, nondeterministic workflow behavior, or a dependency that changes the chunk boundary.

The core invariant is still: one plan node maps to one mergeable unit that gets committed, reviewed, judged, and merged serially.

## Current Baseline

Completed:

- `@durafoundry/domain`: Valibot schemas and semantic plan/snapshot validation.
- `@durafoundry/artifact-store`: local filesystem artifacts, plan bundles, snapshot manifests.
- `@durafoundry/fixture-repo`: generated clean git fixture repository and guarded cleanup.
- `@durafoundry/flue-runtime`: Flue/Codex provider-token integration helper and spike evidence.

Baseline validation:

```bash
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 0: Baseline Recheck

Goal prompt:

```text
/goal Confirm the current DuraFoundry baseline is clean before starting v0 implementation. Run the documented validation commands, inspect failures if any, and make no code changes unless needed to restore the baseline.
```

Write scope:

- None unless baseline validation is broken.

Acceptance:

- `git status --short` is clean before implementation chunks begin.
- All baseline validation commands pass.
- Any failure is diagnosed and either fixed with a small commit or explicitly escalated.

Validation:

```bash
git status --short --branch
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 1: Real Git Activities

Goal prompt:

```text
/goal Implement v0 real git/worktree Activities for DuraFoundry. Use the existing domain schemas and fixture repo package. Add a new package that can prepare a clean repo, create factory-owned worktrees, apply or accept node changes, create node commits, merge them serially to trunk, capture command results/diffs as artifacts where appropriate, and clean up only factory-owned worktrees/branches.
```

Write scope:

- `packages/git-activities/**`
- `packages/domain/**` only for missing contracts required by git Activity inputs/outputs.
- `package.json`, `package-lock.json`, `tsconfig.base.json` only for workspace wiring.

Required behavior:

- Validate repo path and trunk branch before mutation.
- Refuse dirty trunk unless explicitly configured by the local repository safety contract.
- Create factory-owned branches and worktrees with deterministic names.
- Commit node changes with configured author metadata.
- Produce structured results: worktree path, branch name, diff artifact URI if available, commit SHA, merge result, cleanup result.
- Serialize merge entry points at the API boundary; workflow-level queue comes later.
- Cleanup must refuse non-factory worktrees/branches.

Acceptance:

- Tests create a fixture repo, create a node worktree, modify a file, commit it, merge to `main`, and cleanup.
- Tests prove cleanup refuses unmarked/non-factory paths.
- Tests prove dirty trunk or missing branch failures are structured and non-destructive.

Validation:

```bash
npm run typecheck --workspace @durafoundry/git-activities
npm test --workspace @durafoundry/git-activities
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 2: Fake Agent Activities

Goal prompt:

```text
/goal Implement fixture-backed fake planner, coder, reviewer, judge, broad reviewer, broad judge, and gap planner Activities. They must use the domain schemas and artifact store, produce realistic structured reports, support fail-once repair behavior, and avoid any Flue dependency in the v0 workflow slice.
```

Write scope:

- `packages/fake-agent-activities/**`
- `packages/domain/**` only for missing Activity payload contracts.
- `packages/artifact-store/**` only for missing helper APIs.
- Workspace metadata.

Required behavior:

- Fake planner writes a valid plan bundle with node markdown bodies and milestone bodies.
- Fake coder edits fixture files based on node id and repair instructions.
- Fake reviewer can pass, fail once, and then pass after repair.
- Fake judge can pass, fail once, and then pass after repair.
- Broad gates can produce pass reports or structured `GapReport`s.
- Gap planner can turn a `GapReport` into a valid follow-up `PlanDAG`.

Acceptance:

- Plan output passes `validatePlanDAG` and `validatePlanSnapshotManifest`.
- Coder output includes changed files and attempt context.
- Reviewer/judge failures produce repair instructions scoped to the same node.
- Broad gap output produces follow-up graph work only at milestone/final scope.

Validation:

```bash
npm run typecheck --workspace @durafoundry/fake-agent-activities
npm test --workspace @durafoundry/fake-agent-activities
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 3: Temporal Workflow Scaffold

Goal prompt:

```text
/goal Add the Temporal TypeScript workflow package and test harness for DuraFoundry v0. Define FactoryRunWorkflow, PlanIterationWorkflow, NodeExecutionWorkflow, and typed Activity interfaces, but keep side effects in mocked Activities for this chunk.
```

Write scope:

- `packages/workflows/**`
- `packages/domain/**` only for workflow state/query/update contracts.
- Workspace metadata.

Required behavior:

- Workflows import only deterministic-safe code.
- Activities are represented through typed proxies.
- Queries expose run state, plan state, node state, gate state, artifact refs, and latest failure reason.
- Updates include plan approval/rejection, pause, resume, cancel node, gate override, retry from state, skip delay, and request follow-up DAG as stubs or no-op state transitions where full behavior lands later.
- Tests use Temporal's test environment or a deterministic workflow test harness.

Acceptance:

- Workflow package builds without importing Node-only Activity code into workflow code.
- A smoke test starts a factory run with fake/mocked Activities and reaches a waiting-for-plan-approval state.
- Query output is stable and schema-compatible.

Validation:

```bash
npm run typecheck --workspace @durafoundry/workflows
npm test --workspace @durafoundry/workflows
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 4: Plan Approval And Snapshot Execution

Goal prompt:

```text
/goal Implement plan iteration, approval, immutable snapshot creation, and stale approval rejection in the Temporal workflow slice. The workflow should store snapshot ids, hashes, and artifact refs, not large markdown bodies.
```

Write scope:

- `packages/workflows/**`
- `packages/artifact-store/**` only for missing snapshot helpers.
- `packages/domain/**` only for missing approval/snapshot fields.

Required behavior:

- Load a SPEC artifact reference and ask fake planner for a draft plan bundle.
- Validate draft plan graph and snapshot manifest before approval.
- Approve plan through Update.
- Reject stale approval when artifact hash or plan id no longer matches.
- Transition from approved snapshot to executable DAG state.

Acceptance:

- Tests cover approve, reject, request changes, stale approval rejection, and invalid plan rejection.
- Workflow history stores bounded references, not full node markdown bodies.
- Running snapshots are immutable.

Validation:

```bash
npm test --workspace @durafoundry/workflows -- --test-name-pattern "plan|snapshot|approval"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 5: Node Execution Repair Loop

Goal prompt:

```text
/goal Implement NodeExecutionWorkflow behavior for one node: create a worktree, run fake coder, verify, review, judge, repair failed gates on the same node, enforce max attempts, and emit structured node run history.
```

Write scope:

- `packages/workflows/**`
- `packages/git-activities/**` only for missing Activity fields needed by workflow orchestration.
- `packages/fake-agent-activities/**` only for missing repair-loop behavior.
- `packages/domain/**` only for missing node history/state contracts.

Required behavior:

- Node starts only after dependencies are satisfied.
- Attempt records include changed files, command results, diff URI, checkpoint commits, final commit, review reports, judge reports, and repair instructions.
- Verification/review/judge failures drive same-node repair before merge.
- Out-of-scope findings escalate to `needs_human` instead of patching the running graph.
- Max attempts transitions to `needs_human` with enough context to resume or override.

Acceptance:

- Tests cover pass-first-time, reviewer fail then repair pass, judge fail then repair pass, verification fail, and max-attempts escalation.
- Tests prove node-local failures do not append graph work.

Validation:

```bash
npm test --workspace @durafoundry/workflows -- --test-name-pattern "node|repair|judge|review"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 6: DAG Scheduler And Merge Queue

Goal prompt:

```text
/goal Implement DAG scheduling, dependency readiness, parallelism limits, milestone ordering, and root-scoped serial merge queue for the v0 workflow. Use real git Activities against the generated fixture repo in integration tests.
```

Write scope:

- `packages/workflows/**`
- `packages/git-activities/**` only for merge queue integration defects.
- `packages/fake-agent-activities/**` only for multi-node fixture behavior.

Required behavior:

- Topologically schedule ready nodes from the approved snapshot.
- Enforce `maxActiveNodes`, `maxActiveHighRiskNodes`, and `mergeConcurrency: 1`.
- Queue ready-to-merge nodes and merge exactly one trunk mutation at a time.
- Mark merged nodes immutable.
- Cleanup worktrees/branches durably after merge or terminal failure.
- Run milestone broad review/judge after all milestone nodes merge.

Acceptance:

- Tests run at least two independent nodes in parallel and merge them serially.
- Tests cover dependency blocking and high-risk parallelism throttling.
- Tests prove merge queue remains serial even when nodes finish together.
- Fixture repo trunk contains both node changes after completion.

Validation:

```bash
npm test --workspace @durafoundry/workflows -- --test-name-pattern "dag|scheduler|merge|milestone"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 7: Human Follow-Up DAG Control

Goal prompt:

```text
/goal Implement human follow-up DAG control for v0. The workflow must let a human pause scheduling, cancel or skip selected unmerged nodes, submit a GapReport, generate a follow-up DAG, require approval when policy says so, execute follow-up work, and then resume legal original work.
```

Write scope:

- `packages/workflows/**`
- `packages/fake-agent-activities/**` for gap planner behavior.
- `packages/domain/**` only for missing control/result contracts.

Required behavior:

- `requestFollowupDag` Update accepts a `HumanGapRequest`.
- Scheduling pause is durable and queryable.
- Only explicitly selected nodes are cancelled or skipped.
- Follow-up DAG has `parentDagId` and `parentSnapshotId`.
- Approval policy applies to follow-up graph work.
- Completed/merged nodes remain immutable.

Acceptance:

- Tests cover pause-only, pause-plus-cancel, follow-up DAG approval, high-risk follow-up requiring approval, and resume.
- Tests prove unselected active/ready nodes are not silently cancelled.

Validation:

```bash
npm test --workspace @durafoundry/workflows -- --test-name-pattern "followup|gap|pause|resume|cancel"
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 8: CLI Demo Path

Goal prompt:

```text
/goal Ship the v0 CLI/demo path. Add a CLI app that can run DuraFoundry against docs/SPEC.md with a generated fixture repository and local filesystem artifacts, then print run id, workflow id, artifact root, fixture repo path, node commits, merge commits, and final status.
```

Write scope:

- `apps/cli/**`
- `packages/workflows/**` only for worker/client integration needed by CLI.
- `packages/fixture-repo/**` only for missing CLI setup hooks.
- Workspace metadata.

Required behavior:

- Command shape:

```bash
durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry
```

- CLI can create a fixture repo, start worker/client as needed for local demo, submit plan approval if running in auto-approve demo mode, and wait for completion.
- CLI prints machine-readable JSON with the important ids and paths.
- CLI exits nonzero on workflow failure or needs-human terminal state unless an explicit flag allows it.

Acceptance:

- CLI smoke test runs without touching the DuraFoundry repo as the target repo.
- CLI output contains run id, workflow id, artifact root, fixture repo path, node commit SHAs, final status.
- README documents the command and safety boundaries.

Validation:

```bash
npm run typecheck --workspace @durafoundry/cli
npm test --workspace @durafoundry/cli
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
```

## Chunk 9: End-To-End Fixture Acceptance

Goal prompt:

```text
/goal Add end-to-end v0 acceptance tests for the full DuraFoundry fixture run. The test should exercise plan approval, snapshot hashing, DAG scheduling, node repair, real git commits, serial merge, cleanup, milestone gates, human follow-up request behavior, artifact outputs, and CLI execution.
```

Write scope:

- `test/**` or `packages/*/test/**` following the repo's established test layout.
- `apps/cli/**`, `packages/workflows/**`, `packages/git-activities/**`, `packages/fake-agent-activities/**` only for defects discovered by acceptance tests.

Required behavior:

- E2E fixture run starts from a generated repo and local artifact root.
- At least one node exercises fail-once repair.
- At least two nodes merge serially.
- A separate scenario exercises human follow-up DAG request and resume.
- Artifacts are asserted, not just produced.

Acceptance:

- Full acceptance test suite passes locally.
- Test logs identify artifact root and fixture repo path for debugging.
- No test mutates the DuraFoundry repo as its target repo.

Validation:

```bash
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
```

## Chunk 10: Spec Review And Hardening

Goal prompt:

```text
/goal Review the implemented v0 against docs/SPEC.md and docs/execution-plan-v0.md. Find bugs, missing acceptance criteria, unsafe shortcuts, nondeterministic workflow behavior, test gaps, and dependency/security issues. Fix blocking issues immediately and leave a concise next-steps report for nonblocking work.
```

Write scope:

- Any package with a blocking defect.
- `docs/SPEC.md`, `docs/execution-plan-v0.md`, `README.md` for documentation drift.

Review checklist:

- SPEC acceptance criteria are covered or explicitly deferred.
- Workflow code is deterministic.
- Side effects live in Activities.
- Real git operations are guarded by fixture/local safety contracts.
- Snapshot immutability and stale approval rejection are enforced.
- Node-local failures repair the same node before merge.
- New graph work only happens through milestone/final/human follow-up DAGs.
- Merge queue is serial.
- Cleanup is durable and refuses non-factory paths.
- CLI does not target the DuraFoundry repo by default.
- Audit and UBS checks do not surface blocking issues.

Validation:

```bash
npm run typecheck --workspaces --if-present
npm test --workspaces --if-present
npm audit
npm run ubs:diff
git status --short --branch
```

## Completion Definition

V0 is complete when:

- The CLI command can run a full fixture repository factory run from `docs/SPEC.md`.
- The run produces an approved immutable plan snapshot.
- Nodes execute through fake agents, real git worktrees, repair gates, commits, serial merge, and cleanup.
- Milestone gates run.
- Human follow-up DAG request is supported and tested.
- Artifact outputs are inspectable on disk.
- All validation commands pass from a clean checkout.
