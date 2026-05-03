# DuraFoundry Specification

Status: draft v0.1  
Date: 2026-05-02  
Owner: Jeff  
Target stack: Temporal TypeScript SDK, Temporal Server, Flue SDK, `@mariozechner/pi-ai` Codex provider

## 0. Migration and Resumption Context

This document is the canonical DuraFoundry product/architecture specification. It was migrated into the implementation repository from the earlier spec-only repository:

- https://github.com/jefffm/software-factory-orchestrator-spec

The implementation repository is:

- https://github.com/jefffm/durafoundry

The spec is intentionally self-contained: it records the goals, non-goals, Temporal primitive mapping, Flue primitive mapping, structured data contracts, workflow lifecycle, Git/worktree model, UX requirements, security posture, accepted decisions, open questions, first implementation slice, and acceptance criteria needed to resume design work without depending on the original conversation.

Current accepted design direction:

1. Temporal owns durable orchestration, state, approvals, DAG scheduling, repair loops, merge serialization, cancellation, visibility, and replay safety.
2. Flue owns headless agent execution, sessions, scoped tools/commands, typed result extraction, and event streaming.
3. The first implementation slice is Temporal-first with fake or fixture-backed planner/coder/reviewer/judge Activities.
4. V0 uses real local git worktrees, commits, cleanup, and root-scoped serial direct local merge under the local repository safety contract in section 11.2.1.
5. Approvals and authoritative control actions use Temporal Updates, not Signals.
6. Command-line agent runtimes and CLI fallbacks are out of scope. Normal repository commands remain allowed as scoped Flue/Activity tools.
7. Codex subscription support stays Flue/pi-ai-only. The spike confirmed support through Flue provider overrides in `@flue/sdk >= 0.3.7`; DuraFoundry owns userland OAuth resolution and passes only the current access token through `init({ providers })`.
8. iWF is design inspiration only; DuraFoundry keeps direct Temporal TypeScript ownership.
9. V0 ships a CLI/demo path that runs against a generated fixture repository and stores artifacts on the local filesystem.

Next design/implementation work:

1. Scaffold the Temporal-first implementation slice.
2. Define schemas from sections 8-10 as executable TypeScript/Valibot types.
3. Implement fake agent Activities plus real git/artifact Activities and workflow tests for plan approval, DAG scheduling, node repair loops, and root-scoped serial merge.
4. Ship the v0 CLI/demo command against a generated fixture repository.
5. Add a narrow Flue integration after the Temporal workflow shape is executable.
6. Reuse `packages/flue-runtime` for Codex-backed Flue Activities and keep the Flue/Codex spike as a regression tool.

## 1. Executive Summary

Build a software factory orchestrator that turns a human-authored software SPEC into an approved execution DAG, executes that DAG with coding agents, reviews and judges the produced code at multiple levels, merges accepted work through a controlled merge queue, and loops back into new DAGs when review or judgement discovers gaps.

The orchestrator should use Temporal for durable, inspectable orchestration and Flue for programmable headless agent harnesses. Temporal owns state, retries, approvals, durable waits, parallel scheduling, child workflow hierarchy, cancellation, and visibility. Flue owns LLM sessions, agent roles, scoped tool/command access, sandbox/runtime integration, typed result extraction, and streaming agent events.

Codex subscription support should happen inside Flue through `@mariozechner/pi-ai`'s `openai-codex` provider, not by bypassing Flue with a separate command-line agent adapter. The orchestrator's only agent execution primitive should stay `runFlueAgentActivity`. The completed Flue/Codex spike found that Flue provider overrides support this path: DuraFoundry reads and refreshes local Pi OAuth credentials in userland, then passes the current access token to Flue as `providers["openai-codex"].apiKey`.

The central design choice is:

- Use Temporal Workflows for deterministic orchestration state machines.
- Use Temporal Activities for every side effect: Flue calls, git worktree commands, CI commands, filesystem IO, GitHub operations, merge operations, and notification delivery.
- Use Temporal Child Workflows to express hierarchy: spec iteration, plan iteration, node execution, node evaluation, merge, milestone review, gap-to-plan loops.
- Use Temporal Updates for human approvals and interactive mutations that need validation and acknowledgement.
- Use Temporal Signals for asynchronous fire-and-forget events such as external progress notifications, queue completion callbacks, and non-blocking user comments.
- Use Temporal Queries for read-only live state for UX.

## 2. Goals

1. Let a user interactively create a SPEC file outside the orchestrator.
2. Iteratively convert an approved SPEC into a structured DAG execution plan.
3. Let the user approve or reject generated specs and plans.
4. Execute approved DAG nodes with configurable parallelism.
5. Give each execution node an isolated git worktree when configured.
6. Before merge, require both:
   - a bug-oriented code reviewer
   - a specification-compliance judge
7. If either reviewer or judge fails, feed structured findings back into the worker and continue that task.
8. Merge accepted node work back to trunk through a merge queue.
9. Clean up worktrees after merge or terminal cancellation.
10. At milestone or wave boundaries, run broader review and judgement over the integrated unit of work.
11. If broad review or judgement finds gaps, convert those findings into a new structured DAG and run it as follow-up work.
12. Prefer structured data at every boundary: specs, plans, node attempts, review reports, judge reports, merge outcomes, gap reports, and approval decisions.
13. Provide a useful UX for observing, approving, debugging, replaying, and auditing the system.
14. Support subscription-backed Codex execution through Flue/pi-ai for local worker lanes using upstream Flue provider overrides, without private Flue forks or CLI fallbacks.

## 3. Non-Goals for v0

1. Do not build a fully general project management suite.
2. Do not rely on Temporal Workflows to perform direct git, filesystem, network, or LLM side effects.
3. Do not let the agent freely mutate trunk outside the merge queue.
4. Do not treat a passing code review as equivalent to meeting the spec. Review and judgement are separate gates.
5. Do not hand-roll Temporal-like durability or a separate queueing system where Temporal already provides the primitive.
6. Do not use Temporal Schedules for normal factory-run execution. Schedules can trigger recurring factory runs later, but a single software-factory run is a Workflow Execution.
7. Do not support command-line agent runtimes, command-line fallbacks, or shell-scripted agent harness adapters. Flue/pi-ai is the agent runtime boundary.
8. Do not add iWF as an orchestration dependency. Its state-machine ideas are useful, but this project should keep direct Temporal TypeScript ownership.

## 4. Research Basis

This draft is based on source inspection, not guesses. The original investigation used local checkouts under `/home/jeff/Work`; those paths are retained below as provenance for the exact inspected files. The corresponding public upstream projects are:

- Temporal Server: https://github.com/temporalio/temporal
- Temporal TypeScript SDK: https://github.com/temporalio/sdk-typescript
- Flue: https://github.com/withastro/flue
- iWF: https://github.com/indeedeng/iwf
- iWF wiki: https://github.com/indeedeng/iwf/wiki

Important conclusions from the source review are included directly in this document so future design work can continue even if the local checkouts move.

Temporal source references:

- `/home/jeff/Work/temporal/README.md`: Temporal is a durable execution platform for scalable, resilient workflows.
- `/home/jeff/Work/temporal/docs/architecture/README.md`: Workflows are event-sourced; Workflow code must be deterministic and side-effect free; Activities are the side-effecting units.
- `/home/jeff/Work/temporal/docs/architecture/history-service.md`: History handles Start, Cancel, Query, Update, Signal, Reset, worker completions, timers, and state transitions.
- `/home/jeff/Work/temporal/docs/architecture/matching-service.md`: Matching owns Task Queues polled by workers and partitions queues for throughput.
- `/home/jeff/Work/temporal/docs/architecture/workflow-lifecycle.md`: Workflow start, task scheduling, activity scheduling, completion, and timer behavior.

Temporal TypeScript SDK references:

- `/home/jeff/Work/sdk-typescript/README.md`: TypeScript SDK packages and Worker runtime requirements.
- `/home/jeff/Work/sdk-typescript/packages/workflow/src/index.ts`: workflow authoring API overview for timers, activities, updates, signals, and queries.
- `/home/jeff/Work/sdk-typescript/packages/workflow/src/workflow.ts`: `sleep`, `proxyActivities`, `startChild`, `executeChild`, `continueAsNew`, `condition`, `defineUpdate`, `defineSignal`, `defineQuery`, `setHandler`, and `upsertSearchAttributes`.
- `/home/jeff/Work/sdk-typescript/packages/client/src/workflow-client.ts`: client handles for start, result, signal, query, startUpdate, executeUpdate, update-with-start, signal-with-start, cancel, terminate, describe, and history fetch.
- `/home/jeff/Work/sdk-typescript/packages/client/src/workflow-options.ts`: workflow IDs, task queues, idempotency, conflict policies, memo, search attributes, static summary/details, start delay, versioning overrides.
- `/home/jeff/Work/sdk-typescript/packages/worker/src/worker-options.ts`: Worker task queues, activities, workflow bundles, concurrency knobs, rate limits, pollers, cached workflows, sinks, interceptors, worker deployment options.
- `/home/jeff/Work/sdk-typescript/packages/worker/src/worker.ts`: Worker lifecycle, polling, Activity/Workflow task execution, shutdown, replay workers.

Flue source references:

- `/home/jeff/Work/flue/README.md`: Flue is a runtime-agnostic headless agent harness with sessions, tools, skills, roles, sandboxes, typed results, HTTP/SSE deployment modes, and MCP support.
- `/home/jeff/Work/flue/packages/sdk/src/types.ts`: `FlueContext`, `AgentInit`, `FlueAgent`, `FlueSession`, `PromptOptions`, `SkillOptions`, `TaskOptions`, `ToolDef`, `Command`, `SessionEnv`, `FlueEvent`, and `SessionStore`.
- `/home/jeff/Work/flue/packages/sdk/src/session.ts`: prompt, skill, task, shell, result extraction, scoped runtime, child task sessions, event emission, compaction, and session history.
- `/home/jeff/Work/flue/packages/sdk/src/agent.ts`: built-in tools: read, write, edit, bash, grep, glob, task.
- `/home/jeff/Work/flue/packages/sdk/src/client.ts`: `init()` sandbox resolution, model resolution, context discovery, event callbacks.
- `/home/jeff/Work/flue/packages/sdk/src/sandbox.ts`: Bash and remote sandbox adapters into `SessionEnv`.
- `/home/jeff/Work/flue/packages/connectors/src/daytona.ts`: external sandbox connector pattern.
- `/home/jeff/Work/flue/packages/sdk/src/result.ts`: Valibot-backed result schemas and result extraction delimiters.
- `/home/jeff/Work/flue/packages/sdk/src/build-plugin-node.ts` and `build-plugin-cloudflare.ts`: sync, webhook, and SSE modes for Flue agents.

Codex subscription and pi-ai source references:

- `@mariozechner/pi-ai@0.66.1`: locked by Flue through `@mariozechner/pi-agent-core@0.66.1`.
- `pi-ai` generated model registry includes provider `openai-codex` with API `openai-codex-responses` and models such as `openai-codex/gpt-5.3-codex`, `openai-codex/gpt-5.4`, and `openai-codex/gpt-5.4-mini`.
- `pi-ai` provider implementation `dist/providers/openai-codex-responses.js` calls `https://chatgpt.com/backend-api`, accepts an OAuth access token as `apiKey`, extracts `chatgpt_account_id`, and supports `sessionId` prompt caching plus SSE/WebSocket transport.
- `pi-ai` OAuth implementation `dist/utils/oauth/openai-codex.js` implements ChatGPT OAuth login/refresh for OpenAI Codex using provider id `openai-codex`.
- `pi-agent-core` supports `AgentOptions.getApiKey(provider)` and passes the resolved key into `streamSimple`.
- Flue PR #29 added provider overrides to `init({ providers })` and was released in `@flue/sdk@0.3.7`. DuraFoundry can pass a current Codex OAuth access token as `providers["openai-codex"].apiKey`.
- DuraFoundry userland remains responsible for finding, refreshing, and protecting Codex OAuth credentials. Tokens must not be written to prompts, transcripts, logs, Temporal history, memo, search attributes, or committed files.

iWF source references:

- `https://github.com/indeedeng/iwf`: iWF is an abstracted Temporal/Cadence workflow framework with its own server, interpreter workflow, REST worker callbacks, and Java/Go/Python SDKs.
- `https://github.com/indeedeng/iwf/wiki/iWF-Design`: iWF runs an interpreter workflow over Temporal/Cadence and calls user workflow code through REST worker APIs.
- `https://github.com/indeedeng/iwf/wiki/WorkflowState`: iWF models a workflow state as optional `waitUntil` followed by `execute`, with state decisions for next states, parallel branches, completion, failure, or dead end.
- `https://github.com/indeedeng/iwf/wiki/RPC`: iWF RPCs provide synchronous external interactions that can read/write persistence, publish internal messages, or trigger state execution.
- `https://github.com/indeedeng/iwf/wiki/Compare-with-Cadence-Temporal`: iWF hides replay/versioning and continue-as-new behind its interpreter, but this spec keeps direct Temporal primitives for control and TypeScript fit.
- `https://github.com/indeedeng/iwf/wiki/iWF-limitation`: iWF is not suitable for every workload, especially hot single-workflow writes, joins across workflows, and cross-workflow transactions.

## 5. Core Concepts

### 5.1 Factory Run

A Factory Run is one end-to-end attempt to implement an approved SPEC against a target repository and target trunk branch.

Canonical Temporal identity:

```text
workflowId = factory:<repoId>:<specId>:<runId>
workflowType = FactoryRunWorkflow
taskQueue = factory-orchestrator
```

The Factory Run owns:

- spec metadata
- plan metadata
- DAG execution state
- milestone state
- node attempts
- approvals
- review and judge gates
- merge requests and merge results
- broad review/judge findings
- follow-up DAGs generated from broad findings

### 5.2 SPEC

The SPEC is the human-readable and machine-addressable statement of intended work.

The user can create it outside the orchestrator in a repo, editor, issue, or document system. The orchestrator consumes it as a versioned immutable input once a run starts. If spec iteration is enabled, the orchestrator can propose revisions, but the SPEC remains a document artifact outside the core execution engine.

### 5.3 Execution Plan DAG

The execution plan is a structured DAG generated from an approved SPEC. It is a first-class plan graph artifact, not just transient planner output or Temporal Workflow memory.

The editable plan artifact should be stored as a bundle:

```text
.durafoundry/plans/<planId>/
  plan.json
  nodes/<nodeId>.md
  milestones/<milestoneId>.md
  snapshots/<snapshotId>.json
```

`plan.json` is the canonical machine-readable graph. Markdown files hold large human-readable node and milestone bodies: implementation notes, SPEC traceability, examples, constraints, acceptance detail, and review/judge guidance. Structured fields stay small enough for validation, scheduling, indexing, and UI rendering.

It contains:

- nodes
- edges
- milestones or waves
- acceptance criteria
- files/modules expected to be touched
- required tests
- merge strategy
- risk level
- review focus
- judge rubric
- expected structured outputs

Nodes are independently executable units where possible. Edges express hard dependencies.

Plan iteration mutates the draft plan artifact. Approval creates an immutable `PlanSnapshot`; Temporal executes that snapshot. Workflow state stores snapshot ids, hashes, normalized scheduling state, and artifact references, not large markdown bodies or raw Flue transcripts.

Running snapshots should not be mutated in place. V0 does not support general runtime graph patching. If execution discovers work that is outside the scope of any active node, the system either stops for human input or creates an appended follow-up DAG after milestone or final review. Completed or merged nodes remain immutable; defects in merged work are represented as new follow-up repair nodes.

### 5.4 Node

A node is one mergeable unit of implementation, verification, documentation, migration, or cleanup. For coding nodes, it usually owns one git worktree and one final gated commit or diff submitted to the merge queue.

Each node runs through:

1. worktree preparation
2. agent execution
3. local verification
4. reviewer gate
5. judge gate
6. repair loop if either gate fails
7. merge queue
8. cleanup

Reviewer, judge, or verification failures normally do not create new plan nodes. They become durable attempt context for the same node and drive the repair loop before merge. If the failure is outside the node's legitimate scope, reveals missing prerequisite/follow-up work, requires splitting the node, or changes SPEC/plan coverage, v0 escalates to human review or defers the work to a milestone/final follow-up DAG.

### 5.5 Reviewer

The Reviewer is a bug/risk gate. It checks for defects, regressions, race conditions, security issues, missing tests, brittle behavior, and maintainability risks.

The Reviewer does not decide whether the code fulfilled the SPEC unless the issue also manifests as a bug or quality risk.

### 5.6 Judge

The Judge is a spec-compliance gate. It checks whether the code matches the node's requirements and did not cut corners.

The Judge should compare:

- SPEC sections
- plan node requirements
- acceptance criteria
- implementation diff
- tests and evidence
- reviewer output
- known constraints

### 5.7 Milestone or Wave

A milestone/wave is a group of DAG nodes whose integrated result should be evaluated as a coherent unit. After all nodes in the milestone have merged, a broad reviewer and broad judge evaluate the integrated trunk state.

If they find gaps, the system creates a `GapReport` and then a follow-up DAG, optionally after user approval depending on policy. This is the normal place for new graph work; node-local defects should have been repaired before merge.

## 6. Temporal Primitive Mapping

### 6.1 Workflow Types

Use these Temporal Workflow types:

| Domain Primitive | Temporal Primitive | Reason |
| --- | --- | --- |
| Whole factory run | `FactoryRunWorkflow` root workflow | Durable run state, approval waits, DAG scheduler, hierarchy owner |
| Spec iteration phase | `SpecIterationWorkflow` child workflow | Optional bounded sub-state machine for generating/revising spec proposals |
| Plan iteration phase | `PlanIterationWorkflow` child workflow | Converts SPEC to DAG and waits for approval/revision |
| DAG execution phase | `DagExecutionWorkflow` child workflow or root phase | Schedules nodes respecting dependencies and parallelism |
| Node execution | `NodeExecutionWorkflow` child workflow | Isolated retry/repair state per DAG node |
| Node evaluation | `NodeEvaluationWorkflow` or internal node subphase | Reviewer and judge gates with structured findings |
| Merge queue | `MergeQueueWorkflow` singleton per repo/trunk, plus `MergeNodeWorkflow` | Serializes trunk mutations across nodes and runs |
| Milestone review | `MilestoneReviewWorkflow` child workflow | Broad integrated review and judge for a wave |
| Gap-to-plan generation | `GapPlanningWorkflow` child workflow | Converts broad findings into follow-up DAGs |
| Final review | `FinalAcceptanceWorkflow` child workflow | Whole-run review/judge and closeout |

Root workflow can either contain the DAG execution loop directly or delegate to `DagExecutionWorkflow`. Prefer a separate child workflow if the root becomes too large or if follow-up DAGs should be reusable.

### 6.2 Activities

Use Activities for every operation that is non-deterministic or side-effecting:

| Domain Operation | Temporal Activity |
| --- | --- |
| Load SPEC from GitHub/local path | `loadSpecActivity` |
| Persist generated spec/plan artifact | `writeArtifactActivity` |
| Run Flue spec/planner/reviewer/judge/coder | `runFlueAgentActivity` with role-specific args |
| Preflight target repository | `prepareTargetRepoActivity` |
| Create git worktree | `createWorktreeActivity` |
| Run scoped repository command in worktree | `runCommandActivity` |
| Compute diff | `collectDiffActivity` |
| Validate changed-file scope | `validateDiffScopeActivity` |
| Run tests/linters | `runVerificationActivity` |
| Commit task result | `commitWorktreeActivity` |
| Rebase/sync worktree | `rebaseWorktreeActivity` |
| Merge to trunk | `mergeWorktreeActivity` |
| Cleanup worktree | `cleanupWorktreeActivity` |
| Push branch or open PR if configured | `publishBranchActivity` |
| Send UI/webhook notification | `notifyActivity` |
| Record event to external DB | `recordRunEventActivity` |

Activity rules:

- Activities must be idempotent where Temporal retry is enabled.
- Git activities must accept explicit IDs and paths so retries can detect existing state.
- Cleanup activities should be best-effort but recorded.
- Long-running Activities must heartbeat.
- Activities must honor cancellation where possible.
- Command execution is allowed for repository mechanics such as git, tests, linters, package managers, and scoped Flue tools. It is not allowed as an agent runtime adapter.

### 6.3 Updates

Use Temporal Updates for interactions that should validate input, mutate workflow state, and return an authoritative result to the caller.

Required Updates on `FactoryRunWorkflow`:

| Update | Input | Output | Purpose |
| --- | --- | --- | --- |
| `submitSpecDecision` | `ApprovalDecision<SpecDocument>` | `SpecDecisionResult` | Approve/reject/request changes for spec proposal |
| `submitPlanDecision` | `ApprovalDecision<PlanDAG>` | `PlanDecisionResult` | Approve/reject/request changes for DAG plan |
| `setParallelism` | `ParallelismConfigPatch` | `ParallelismConfig` | Change run concurrency while execution is active |
| `pauseRun` | `PauseRequest` | `RunStatus` | Durable pause |
| `resumeRun` | `ResumeRequest` | `RunStatus` | Durable resume |
| `cancelNode` | `NodeControlRequest` | `NodeStatus` | Cancel a node or mark it skipped where legal |
| `overrideGate` | `GateOverrideDecision` | `GateStatus` | Human override of reviewer/judge failure |
| `approveFollowupDag` | `ApprovalDecision<PlanDAG>` | `PlanDecisionResult` | Approve follow-up DAG work from broad review findings |
| `requestFollowupDag` | `HumanGapRequest` | `HumanGapResult` | Stop wasteful execution and request immediate follow-up DAG planning |
| `appendHumanInstruction` | `HumanInstruction` | `InstructionAck` | Add structured instruction to active or future agent attempts |
| `retryFromState` | `StateRetryRequest` | `StateRetryResult` | Re-run a failed/needs-human phase from a named state boundary |
| `skipDelay` | `SkipDelayRequest` | `SkipDelayResult` | Test/operator-only bypass for a durable timer or backoff delay |

Why Updates instead of Signals for approvals:

- Updates can run synchronous validation before acceptance.
- Updates can return structured acknowledgement.
- Updates can fail if the workflow is in the wrong state.
- Updates give the UX a clear "accepted/rejected/applied" response.

Do not use Signals for approvals. If a UI or service cannot wait for the full Update result, it should call Temporal Client `startUpdate(..., { waitForStage: 'ACCEPTED' })`, store the returned update handle/id, and poll or await the result later. This preserves Workflow-side validation and rejection while still giving the caller non-blocking UX.

Signal vs `startUpdate(... waitForStage: 'ACCEPTED')`:

| Capability | Signal | `startUpdate` accepted stage |
| --- | --- | --- |
| Fire-and-forget delivery | Yes | No; caller waits for acceptance/rejection |
| Workflow-side validation before acceptance | No authoritative caller-visible rejection | Yes |
| Structured acknowledgement | No | Yes, via accepted/rejected update handle |
| Later result retrieval | Requires custom query/state | Built into update handle/result |
| Good fit | comments, webhooks, external event nudges | approvals, control actions, queue enqueue, overrides |

### 6.4 Signals

Use Signals for fire-and-forget events:

| Signal | Target | Purpose |
| --- | --- | --- |
| `externalCommentAdded` | Factory run | Attach non-blocking comment/context |
| `mergeCompleted` | Factory run | Completion callback from global merge queue |
| `mergeFailed` | Factory run | Failure callback from global merge queue |
| `queueWakeup` | Merge queue | Nudge queue after external condition changed |
| `ciWebhookReceived` | Merge queue or node workflow | Attach CI result event |
| `flueStreamEvent` | optional observer workflow | Attach coarse Flue event when mirrored through activities |

### 6.5 Queries

Use Queries for read-only state:

| Query | Output |
| --- | --- |
| `getRunSummary` | High-level run status, current phase, active nodes, blockers |
| `getDagState` | Full DAG with per-node states |
| `getNodeState(nodeId)` | Attempts, worktree, reviewer/judge reports, merge state |
| `getMilestoneState(milestoneId)` | Milestone status and broad findings |
| `getApprovalRequest` | Current pending approval payload |
| `getEventTimeline` | Workflow-owned event summaries |
| `getMergeQueueState` | Pending/current/completed merge requests |
| `getStateDefinitions` | Static state definitions and legal transitions for current workflow type |
| `getActiveStateExecutions` | Active phase/state execution IDs, wait conditions, and blockers |

Queries must not mutate workflow state and must avoid expensive reconstruction. Keep query-ready state in workflow memory.

### 6.6 Child Workflows

Use child workflows for isolation and hierarchy. Child workflows give each meaningful unit its own event history, cancellation boundary, retry policy, and visibility.

Recommended child workflow IDs:

```text
factory:<repoId>:<specId>:<runId>:spec-iteration:<iteration>
factory:<repoId>:<specId>:<runId>:plan-iteration:<iteration>
factory:<repoId>:<specId>:<runId>:dag:<dagId>
factory:<repoId>:<specId>:<runId>:node:<nodeId>
factory:<repoId>:<specId>:<runId>:milestone:<milestoneId>
factory:<repoId>:<specId>:<runId>:gap-plan:<gapPlanId>
merge-queue:<repoId>:<targetBranch>
merge:<repoId>:<targetBranch>:<requestId>
```

Use meaningful workflow IDs for idempotency. Avoid random IDs except for internal attempt IDs.

### 6.7 Continue-As-New

Use `continueAsNew` when:

- Factory runs accumulate many node attempts.
- Long repair loops generate large histories.
- Merge queues are long-lived singleton workflows.
- A recurring observer workflow accumulates many events.
- A factory run exceeds configured state-transition, signal/update, or event-count thresholds.

Carry forward compact state:

- current plan DAG state
- node statuses
- pending merge queue
- approval state
- milestone summaries
- artifact references
- last processed event IDs

Do not carry raw Flue transcripts in workflow state. Store transcripts as external artifacts and keep references.

### 6.8 Search Attributes, Memo, Static Summary, Static Details

Use typed search attributes for UX and filtering:

| Search Attribute | Type | Example |
| --- | --- | --- |
| `FactoryRunId` | Keyword | `run_20260502_001` |
| `RepoId` | Keyword | `github:jefffm/project` |
| `SpecId` | Keyword | `spec_checkout_refactor` |
| `FactoryPhase` | Keyword | `executing`, `awaiting_plan_approval` |
| `PlanId` | Keyword | `plan_v3` |
| `MilestoneId` | Keyword | `auth_migration` |
| `FactoryStateId` | Keyword | `node_execution.review` |
| `ActiveStateIds` | KeywordList | `['plan.awaiting_approval', 'node.auth.running']` |
| `Blocked` | Bool | `true` |
| `NeedsHuman` | Bool | `true` |
| `RiskLevel` | Keyword | `high` |

Use memo for non-indexed metadata:

- spec URI
- plan URI
- trunk branch
- repository URL
- created by
- UI URL

Use static summary/details for Temporal UI display:

- summary: `Factory run: repo@branch specId phase`
- details: markdown containing spec URI, current approval, active node counts, and dashboard link

### 6.9 iWF-Inspired State Contracts

Borrow iWF's explicit state-machine discipline without adopting iWF's server, SDKs, REST callback model, or interpreter workflow.

Every meaningful factory phase should have a named state contract:

```ts
interface FactoryStateDefinition {
  stateId: FactoryStateId;
  ownerWorkflowType: string;
  kind: 'spec' | 'plan' | 'dag' | 'node' | 'gate' | 'merge' | 'milestone' | 'gap' | 'final';
  waitsFor: StateWaitCondition[];
  executes: StateAction[];
  legalNextStates: string[];
  retryPolicy: 'none' | 'activity' | 'state' | 'human';
  resetPolicy: 'forbidden' | 'operator-only' | 'allowed';
}

type StateWaitCondition =
  | { type: 'approval'; approvalKind: 'spec' | 'plan' | 'gap-dag' | 'override' }
  | { type: 'dependency'; nodeIds: NodeId[] }
  | { type: 'timer'; delayId: string; durationSeconds: number }
  | { type: 'external-event'; signalName: string }
  | { type: 'child-workflow'; workflowId: string };

type StateAction =
  | { type: 'activity'; activityName: string }
  | { type: 'child-workflow'; workflowType: string }
  | { type: 'transition'; to: string }
  | { type: 'continue-as-new' }
  | { type: 'complete' }
  | { type: 'fail' }
  | { type: 'needs-human' };
```

Mapping from iWF ideas to this design:

| iWF idea | Adopted design |
| --- | --- |
| `WorkflowState` | Named phase/state definitions inside Temporal Workflows |
| `waitUntil` | `condition`, Updates, Signals, timers, and child workflow completion waits |
| `execute` | Activities, child workflows, and deterministic transition logic |
| `StateDecision` | Structured transition result with legal next states |
| RPC | Temporal Updates with validation and synchronous acknowledgement |
| Internal channel | Workflow-owned queues/event tables, or child workflow Signals where cross-boundary communication is needed |
| Data/Search attributes | Typed workflow state plus explicit Search Attributes for operator visibility |
| Auto continue-as-new | Explicit thresholds and compact carry-forward snapshots |
| Skip timer | `skipDelay` operator/test Update |
| Reset by state | `retryFromState` operator Update with state contract validation |

Rules:

- A state transition must produce a structured event summary.
- A state may only transition to a declared legal next state unless it escalates to `needs-human`.
- State reset/retry must be explicit, audited, and blocked for states with irreversible external side effects unless their compensation policy is defined.
- `skipDelay` must be rejected outside test/operator-authorized flows. Production use requires explicit RBAC, an audit reason, and a state/version precondition.
- The dashboard should render these state definitions and active state executions so operators can reason about the run without reading raw Temporal history.

### 6.10 Task Queues and Worker Layout

Use separate Temporal task queues by function and resource profile:

| Task Queue | Runs |
| --- | --- |
| `factory-orchestrator` | Workflows and lightweight orchestration Activities |
| `factory-flue` | LLM/Flue Activities |
| `factory-git` | git worktree, rebase, merge Activities |
| `factory-ci` | tests, build, lint Activities |
| `factory-notify` | notifications and external status writes |

Rationale:

- Flue and git work have different latency, resource usage, and failure modes.
- Merge operations should be constrained independently.
- CI/test execution may need higher process isolation.
- Worker-level concurrency knobs can be tuned per queue.

Recommended Worker options:

- `maxConcurrentWorkflowTaskExecutions`: controls Workflow Task concurrency.
- `maxConcurrentActivityTaskExecutions`: controls Activity concurrency.
- `maxConcurrentActivityTaskPolls`: tune when queues have backlog but slots are not filling.
- `maxActivitiesPerSecond`: useful for rate-limiting expensive agent calls.
- `maxTaskQueueActivitiesPerSecond`: server-side task queue rate limit, use cautiously.
- `workflowThreadPoolSize`: usually default; increase only if workflow task timeouts occur with large histories.
- `maxCachedWorkflows`: ensure it can hold active factory and node workflows.

Factory-level parallelism is not the same as worker concurrency:

- Factory-level parallelism decides how many DAG nodes may be active for a run.
- Worker concurrency decides how many Temporal tasks a Worker process may execute.
- The system needs both.

## 7. Flue Primitive Mapping

### 7.1 Flue Roles

Define these Flue roles:

| Role | Purpose |
| --- | --- |
| `spec_writer` | Creates or revises structured SPEC proposals |
| `planner` | Converts approved SPEC into Plan DAG |
| `coder` | Implements a node in an isolated worktree |
| `reviewer` | Finds bugs, regressions, and missing tests in a node diff |
| `judge` | Judges node diff against node requirements and SPEC |
| `broad_reviewer` | Reviews integrated milestone diff and system behavior |
| `broad_judge` | Judges milestone against SPEC and plan intent |
| `gap_planner` | Converts broad findings into follow-up DAG nodes |
| `merge_assistant` | Diagnoses merge conflicts and proposes repairs |

### 7.1.1 Codex Subscription Model Path

Codex subscription support is a Flue model/auth configuration, not a separate agent runtime.

Current upstream Flue can resolve pi-ai model strings, run sessions, grant commands/tools, validate Valibot result schemas, persist session history, emit Flue events, and accept provider runtime settings through `init({ providers })`. The v0 orchestrator must restrict itself to that upstream Flue surface. It must not depend on a private Flue fork or orchestrator-local patch to Flue.

The intended Codex subscription model ids use provider `openai-codex`:

```ts
const agent = await init({
  sandbox: 'local',
  model: 'openai-codex/gpt-5.3-codex',
  providers: {
    'openai-codex': { apiKey: accessToken },
  },
});
```

DuraFoundry obtains `accessToken` outside Flue by reading and refreshing local Pi OAuth credentials in an Activity process. V0 role defaults should still be logical policies rather than hard-coded Codex model ids:

| Role | V0 model policy |
| --- | --- |
| `coder` | configured implementation model; subscription Codex is allowed when local credentials are available |
| `reviewer` | independent model from coder where practical |
| `judge` | stronger or fresher model/session than coder/reviewer where available |
| `broad_reviewer` | stronger model, fresh session |
| `broad_judge` | strongest available model, fresh session |
| `planner` / `gap_planner` | strong structured-output model; must prove reliable schema extraction |

Required Flue integration for subscription Codex:

1. Flue accepts a provider API key override for provider `openai-codex`.
2. DuraFoundry supplies the current OAuth access token with `providers["openai-codex"].apiKey`.
3. DuraFoundry refreshes OAuth credentials before Flue agent initialization when expiry is near.
4. The orchestrator stores OAuth credentials outside Temporal Workflow state and outside prompts, then supplies only opaque credential references to Activities.
5. Provider session affinity and transport policy remain optional follow-up work; the v0 supported path uses Flue sessions and pi-ai's default Codex transport.

Codex spike acceptance criteria:

1. Verify whether unmodified upstream Flue can successfully call `openai-codex/*` with subscription OAuth through provider overrides.
2. Verify result extraction, event streaming, command use, cancellation, and compaction with the chosen Codex model path.
3. Verify no OAuth access/refresh token appears in prompts, Flue transcripts, artifacts, Temporal memo/search attributes, or Workflow history.
4. Do not add a command-line Codex adapter, diagnostics fallback, or compatibility execution path.

Do not put Codex OAuth access tokens into prompts, Flue transcript artifacts, Temporal memo/search attributes, or workflow history.

Do not add a command-line Codex adapter, diagnostics fallback, or compatibility execution path. If a model is not reachable through Flue/pi-ai, it is not part of this orchestrator's agent surface.

### 7.2 Flue Sessions

Use stable Flue agent/session IDs so retries can resume where appropriate:

```text
agent id = factory:<runId>:node:<nodeId>:attempt:<attempt>
session id = coder | reviewer | judge | broad-reviewer | broad-judge | gap-planner
```

Guidelines:

- Coder sessions should persist across repair attempts for a node if the same worktree is reused.
- Reviewer and judge sessions should generally be fresh per evaluation to reduce anchoring.
- Broad reviewers should see milestone artifacts, not all raw transcripts unless needed.
- Store full Flue session history externally or in Flue's configured store, not in Temporal workflow state.

### 7.3 Flue Sandbox Mapping

Use Flue `sandbox: 'local'` for local development and CI environments where the target repository is already mounted.

For production isolation, wrap external sandboxes with Flue `SandboxFactory`. The Daytona connector shows the pattern: create external sandbox outside Flue, adapt filesystem and exec to `SessionEnv`, and optionally clean up on destroy.

Recommended v0:

- Start with local git worktrees on the host running `factory-git` and `factory-flue` workers.
- Add container/Daytona sandboxes after the workflow semantics are stable.

Per node:

1. Temporal `createWorktreeActivity` creates a worktree path.
2. `runFlueAgentActivity` initializes a Flue agent with `cwd` set to that worktree.
3. Flue grants commands per call, not globally.
4. Coder gets commands such as `git`, package manager, test runner, and maybe `gh` if required.
5. Reviewer/judge get read-only or restricted commands where possible.

### 7.4 Flue Typed Results

Use Valibot schemas for Flue outputs because Flue supports `result: v.object(...)` and schema-validated extraction.

Valibot is the v0 domain schema library. `packages/domain` should export both TypeScript types and Valibot schemas for all Workflow/Activity payloads. Agent-facing result schemas should reuse these domain schemas instead of defining separate prompt-only shapes.

Every Flue call that controls orchestration must return a schema-validated result:

- spec proposal
- plan DAG
- coder attempt result
- review report
- judge report
- broad findings
- follow-up DAG

Free-form text may be stored as an artifact, but Workflow decisions must use structured fields.

### 7.5 Flue Events

Flue emits events such as:

- `agent_start`
- `text_delta`
- `tool_start`
- `tool_end`
- `turn_end`
- `command_start`
- `command_end`
- `task_start`
- `task_end`
- `compaction_start`
- `compaction_end`
- `idle`
- `error`

Use these for live UX streaming, but do not store every token in Temporal history.

Recommended approach:

- `runFlueAgentActivity` streams Flue events to an external event sink keyed by `runId/nodeId/attemptId/sessionId`.
- The Activity heartbeats coarse progress to Temporal.
- The Workflow stores only artifact URIs and summarized event checkpoints.

## 8. Structured Data Model

### 8.1 IDs

Use stable IDs everywhere.

```ts
type RunId = string;
type SpecId = string;
type SpecVersion = string;
type PlanId = string;
type DagId = string;
type NodeId = string;
type MilestoneId = string;
type AttemptId = string;
type ArtifactUri = string;
type RepoId = string;
type FactoryStateId = string;
type StateExecutionId = string;
type DelayId = string;
```

### 8.2 Spec Document

```ts
interface SpecDocument {
  specId: SpecId;
  version: SpecVersion;
  title: string;
  sourceUri: ArtifactUri;
  createdAt: string;
  author: string;
  status: 'draft' | 'proposed' | 'approved' | 'superseded' | 'rejected';
  problemStatement: string;
  goals: string[];
  nonGoals: string[];
  requirements: Requirement[];
  constraints: Constraint[];
  acceptanceCriteria: AcceptanceCriterion[];
  risks: Risk[];
  openQuestions: OpenQuestion[];
  targetRepo: RepoTarget;
}

interface Requirement {
  id: string;
  text: string;
  priority: 'must' | 'should' | 'could';
  source?: string;
}

interface Constraint {
  id: string;
  text: string;
  kind: 'technical' | 'product' | 'security' | 'performance' | 'compatibility' | 'process';
}

interface AcceptanceCriterion {
  id: string;
  text: string;
  verification: 'test' | 'review' | 'manual' | 'static-analysis' | 'runtime-check';
}

interface Risk {
  id: string;
  text: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation?: string;
}

interface OpenQuestion {
  id: string;
  text: string;
  blocking: boolean;
}

interface RepoTarget {
  repoId: RepoId;
  cloneUrl: string;
  trunkBranch: string;
  packageManager?: string;
  testCommands: string[];
}
```

### 8.3 Plan DAG

```ts
interface PlanDAG {
  planId: PlanId;
  dagId: DagId;
  parentDagId?: DagId;
  parentSnapshotId?: PlanSnapshotId;
  specId: SpecId;
  specVersion: SpecVersion;
  createdAt: string;
  plannerModel: string;
  status: 'draft' | 'proposed' | 'approved' | 'executing' | 'completed' | 'superseded';
  artifactUri: ArtifactUri;
  approvedSnapshotId?: PlanSnapshotId;
  summary: string;
  assumptions: string[];
  milestones: Milestone[];
  nodes: TaskNode[];
  edges: DagEdge[];
  globalAcceptanceCriteria: string[];
  parallelism: ParallelismConfig;
  mergePolicy: MergePolicy;
}

interface Milestone {
  id: MilestoneId;
  title: string;
  bodyUri?: ArtifactUri;
  description: string;
  nodeIds: NodeId[];
  reviewPolicy: MilestoneReviewPolicy;
  acceptanceCriteria: string[];
}

interface TaskNode {
  id: NodeId;
  milestoneId: MilestoneId;
  title: string;
  kind: 'code' | 'test' | 'docs' | 'migration' | 'analysis' | 'cleanup';
  bodyUri: ArtifactUri;
  description: string;
  requirements: string[];
  specRequirementIds: string[];
  acceptanceCriteria: string[];
  expectedFiles?: string[];
  forbiddenFiles?: string[];
  verificationCommands: string[];
  reviewerFocus: string[];
  judgeRubric: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  worktree: WorktreePolicy;
  maxAttempts: number;
}

interface DagEdge {
  from: NodeId;
  to: NodeId;
  reason: string;
}

interface ParallelismConfig {
  maxActiveNodes: number;
  maxActiveHighRiskNodes: number;
  maxActivePerMilestone?: number;
  mergeConcurrency: 1;
}

interface WorktreePolicy {
  mode: 'none' | 'per-node' | 'per-attempt';
  baseRef: string;
  cleanup: 'after-merge' | 'after-run' | 'manual';
}

interface MergePolicy {
  mode: 'direct-to-trunk' | 'branch-and-pr' | 'local-only';
  trunkBranch: string;
  requireGreenVerification: boolean;
  rebaseBeforeMerge: boolean;
  squash: boolean;
}

interface MilestoneReviewPolicy {
  runBroadReview: boolean;
  runBroadJudge: boolean;
  autoPlanGaps: boolean;
  requireApprovalForGapWork: 'always' | 'high-risk-only' | 'never';
}

type PlanSnapshotId = string;

interface PlanSnapshot {
  snapshotId: PlanSnapshotId;
  planId: PlanId;
  dagId: DagId;
  planVersion: number;
  specId: SpecId;
  specVersion: SpecVersion;
  specSha256: string;
  artifactUri: ArtifactUri;
  manifestUri: ArtifactUri;
  manifestSha256: string;
  createdAt: string;
  approvedBy: string;
  status: 'approved' | 'executing' | 'completed' | 'superseded';
}

interface PlanSnapshotManifest {
  snapshotId: PlanSnapshotId;
  planJson: SnapshotArtifact;
  nodeBodies: Record<NodeId, SnapshotArtifact>;
  milestoneBodies: Record<MilestoneId, SnapshotArtifact>;
  createdAt: string;
}

interface SnapshotArtifact {
  uri: ArtifactUri;
  sha256: string;
  kind: 'plan-json' | 'node-body' | 'milestone-body';
}
```

### 8.3.1 State Execution Metadata

Named state execution metadata should be recorded for every major phase, node subphase, approval wait, and operator reset boundary.

```ts
interface FactoryStateExecution {
  stateExecutionId: StateExecutionId;
  stateId: FactoryStateId;
  ownerWorkflowId: string;
  ownerWorkflowType: string;
  status: 'waiting' | 'executing' | 'completed' | 'failed' | 'skipped' | 'needs_human';
  startedAt: string;
  completedAt?: string;
  waitsFor: StateWaitCondition[];
  lastTransition?: StateTransitionEvent;
  artifactUris: ArtifactUri[];
}

interface StateTransitionEvent {
  eventId: string;
  stateExecutionId: StateExecutionId;
  fromStateId: FactoryStateId;
  toStateId: FactoryStateId | 'complete' | 'fail' | 'needs-human';
  reason: string;
  at: string;
  actor: 'workflow' | 'activity' | 'human' | 'system';
  artifactUris: ArtifactUri[];
}

interface StateRetryRequest {
  stateExecutionId: StateExecutionId;
  requestedBy: string;
  reason: string;
  instructions?: string;
  expectedStateVersion?: string;
}

interface StateRetryResult {
  accepted: boolean;
  newStateExecutionId?: StateExecutionId;
  rejectedReason?: string;
}

interface SkipDelayRequest {
  delayId: DelayId;
  requestedBy: string;
  reason: string;
  operatorMode: 'test' | 'production';
  expectedStateVersion?: string;
}

interface SkipDelayResult {
  accepted: boolean;
  affectedStateExecutionId?: StateExecutionId;
  rejectedReason?: string;
}
```

### 8.4 Node State

```ts
interface NodeExecutionState {
  nodeId: NodeId;
  planSnapshotId: PlanSnapshotId;
  status:
    | 'blocked'
    | 'ready'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_judgement'
    | 'repairing'
    | 'ready_to_merge'
    | 'queued_for_merge'
    | 'merging'
    | 'merged'
    | 'failed'
    | 'skipped'
    | 'needs_human';
  dependencyIds: NodeId[];
  attemptIds: AttemptId[];
  activeAttemptId?: AttemptId;
  worktreePath?: string;
  branchName?: string;
  latestDiffUri?: ArtifactUri;
  checkpointCommits: string[];
  latestReview?: ReviewReport;
  latestJudgement?: JudgeReport;
  mergeRequestId?: string;
  mergedCommitSha?: string;
  failureReason?: string;
}
```

### 8.5 Attempt Result

```ts
interface NodeAttemptResult {
  attemptId: AttemptId;
  nodeId: NodeId;
  planSnapshotId: PlanSnapshotId;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  changedFiles: string[];
  commandsRun: CommandResult[];
  testResults: VerificationResult[];
  diffUri: ArtifactUri;
  checkpointCommits: string[];
  commitSha?: string;
  agentSessionUri: ArtifactUri;
  knownLimitations: string[];
  needsFollowup: boolean;
}

interface NodeRunHistory {
  nodeId: NodeId;
  planSnapshotId: PlanSnapshotId;
  attemptIds: AttemptId[];
  reviewReportIds: string[];
  judgeReportIds: string[];
  repairInstructions: RepairInstruction[];
  finalGatedCommitSha?: string;
}

interface RepairInstruction {
  repairInstructionId: string;
  nodeId: NodeId;
  source: 'verification' | 'review' | 'judge' | 'diff-scope' | 'human';
  scope: GateFailureScope;
  summary: string;
  requiredFixes: string[];
  implicatedFiles: string[];
  testsToRun: string[];
  forbiddenChanges: string[];
  sourceReportIds: string[];
  createdAt: string;
}

type GateFailureScope =
  | 'node_local'
  | 'dependency_gap'
  | 'plan_gap'
  | 'spec_gap'
  | 'ambiguous';

interface GateFailureClassification {
  scope: GateFailureScope;
  explanation: string;
  recommendedAction: 'repair_node' | 'create_followup_dag' | 'request_spec_change' | 'needs_human';
}

interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdoutUri?: ArtifactUri;
  stderrUri?: ArtifactUri;
  durationMs: number;
}

interface VerificationResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
  artifactUri?: ArtifactUri;
}
```

### 8.6 Review Report

```ts
interface ReviewReport {
  reportId: string;
  nodeId?: NodeId;
  milestoneId?: MilestoneId;
  reviewerRole: 'reviewer' | 'broad_reviewer';
  status: 'pass' | 'fail' | 'needs_human';
  summary: string;
  findings: ReviewFinding[];
  failureClassification?: GateFailureClassification;
  requiredFixes: string[];
  recommendedFixes: string[];
  evidenceUris: ArtifactUri[];
}

interface ReviewFinding {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'bug' | 'test-gap' | 'regression' | 'security' | 'performance' | 'maintainability' | 'race' | 'data-loss';
  title: string;
  description: string;
  file?: string;
  line?: number;
  blocking: boolean;
}
```

### 8.7 Judge Report

```ts
interface JudgeReport {
  reportId: string;
  nodeId?: NodeId;
  milestoneId?: MilestoneId;
  judgeRole: 'judge' | 'broad_judge';
  status: 'pass' | 'fail' | 'needs_human';
  summary: string;
  requirementResults: RequirementJudgement[];
  cutCornerFindings: CutCornerFinding[];
  failureClassification?: GateFailureClassification;
  requiredFixes: string[];
  evidenceUris: ArtifactUri[];
}

interface RequirementJudgement {
  requirementId: string;
  status: 'satisfied' | 'partially_satisfied' | 'not_satisfied' | 'not_applicable';
  explanation: string;
  evidence: string[];
}

interface CutCornerFinding {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  expectedApproach: string;
  observedApproach: string;
  blocking: boolean;
}
```

### 8.8 Approval Decision

```ts
interface ApprovalDecision<TPayload> {
  decisionId: string;
  actor: string;
  decidedAt: string;
  action: 'approve' | 'reject' | 'request_changes';
  workflowId: string;
  workflowRunId?: string;
  targetArtifactUri: ArtifactUri;
  targetArtifactSha256: string;
  payloadVersion: string;
  payload?: TPayload;
  comments: string;
  structuredComments?: ApprovalComment[];
}

interface ApprovalComment {
  targetId?: string;
  severity: 'info' | 'blocking';
  text: string;
}
```

Approval handlers must reject stale decisions. At minimum, the Update validator must confirm the decision targets the currently pending artifact URI, artifact hash, payload version, and workflow execution. This prevents a UI tab or automation job from approving an older spec/plan after a newer proposal has been generated.

### 8.9 Gap Report and Follow-Up DAG

```ts
interface GapReport {
  gapReportId: string;
  source:
    | 'milestone_review'
    | 'milestone_judge'
    | 'final_review'
    | 'final_judge'
    | 'human_intervention';
  milestoneId?: MilestoneId;
  summary: string;
  gaps: GapFinding[];
  recommendedPlan: 'repair_dag' | 'manual_review' | 'accept_with_risk';
}

interface GapFinding {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'missing-requirement' | 'integration-bug' | 'design-gap' | 'test-gap' | 'quality-gap';
  description: string;
  affectedRequirements: string[];
  suggestedTasks: string[];
  blocking: boolean;
}

interface HumanGapRequest {
  requestId: string;
  actor: string;
  reason: string;
  gapReport: GapReport;
  pauseScheduling: boolean;
  cancelNodeIds?: NodeId[];
  markUnstartedNodeIdsSkipped?: NodeId[];
  requiresApprovalOverride?: boolean;
}

interface HumanGapResult {
  accepted: boolean;
  runPaused: boolean;
  cancelledNodeIds: NodeId[];
  gapReportId?: string;
  followupDagId?: DagId;
  pendingApproval?: boolean;
  rejectedReason?: string;
}
```

## 9. Workflow Lifecycle

### 9.1 Factory Run State Machine

```text
CREATED
  -> LOADING_SPEC
  -> SPEC_ITERATION? 
  -> AWAITING_SPEC_APPROVAL?
  -> PLANNING
  -> AWAITING_PLAN_APPROVAL
  -> EXECUTING_DAG
  -> REVIEWING_MILESTONE*
  -> PLANNING_GAPS*
  -> EXECUTING_FOLLOWUP_DAG*
  -> FINAL_REVIEW
  -> COMPLETED

Any state -> PAUSED
Any state -> CANCELLING -> CANCELLED
Any recoverable failure -> NEEDS_HUMAN
Any unrecoverable failure -> FAILED
```

### 9.2 Spec Phase

The user creates a SPEC outside the orchestrator. The run can start in one of three modes:

1. `external_approved_spec`: user provides an already approved SPEC URI.
2. `external_draft_spec`: user provides draft SPEC URI; orchestrator asks for approval.
3. `agent_assisted_spec`: orchestrator runs `SpecIterationWorkflow` to generate or refine the SPEC, then asks for approval.

Spec approval should use `submitSpecDecision` Update.

If user requests changes:

1. Record structured approval comments.
2. Run `SpecIterationWorkflow` with prior spec and comments.
3. Produce new `SpecDocument` with incremented version.
4. Wait for approval again.

### 9.3 Plan Phase

`PlanIterationWorkflow` uses Flue planner role to generate or revise the editable plan graph artifact. The machine-readable output is `PlanDAG`; large node and milestone bodies are written as markdown artifacts referenced by URI.

Planner prompt must include:

- approved SPEC
- repository context summary
- target branch
- known commands/tests
- constraints from AGENTS.md or project docs
- desired node granularity
- parallelism policy
- reviewer/judge requirements
- requirement that one node maps to one mergeable, reviewable, judgeable unit

Plan validation activity must check:

- schema validity
- all edge node IDs exist
- DAG has no cycles
- all nodes belong to milestones
- milestones contain valid node IDs
- no node has impossible worktree policy
- every node has acceptance criteria
- every node has a markdown body artifact
- risky nodes have verification commands or explain why not
- every node is plausibly mergeable as one gated unit
- edges do not force an impossible merge order

Plan approval should use `submitPlanDecision` Update. Approval creates an immutable `PlanSnapshot` and `PlanSnapshotManifest` with content hashes for `plan.json`, every node body, and every milestone body. The root workflow executes the snapshot manifest, not the mutable draft artifact.

If user requests changes before approval:

1. Record structured comments against graph, node, edge, milestone, or markdown body targets.
2. Run planner again with comments and previous plan.
3. Validate new plan.
4. Wait for approval again.

If plan changes are required after execution has started, do not mutate the active snapshot. V0 does not patch the running graph. Node-local failures repair the same node; broader gaps are collected for milestone/final follow-up DAGs or escalated to `NEEDS_HUMAN`.

Human operators may also stop wasteful execution when they discover a serious gap before a milestone boundary. `requestFollowupDag` records a human-authored `GapReport`, optionally pauses scheduling, cancels selected running nodes, skips selected unstarted nodes, and starts `GapPlanningWorkflow` immediately. The result is still an appended follow-up DAG with its own approval policy; it does not mutate the active snapshot or rewrite completed nodes.

### 9.4 DAG Execution Phase

The DAG scheduler should be deterministic inside Temporal Workflow code and should operate from an immutable `PlanSnapshot`.

State:

- `pending`: nodes whose dependencies are not all merged/skipped.
- `ready`: dependencies satisfied.
- `running`: child `NodeExecutionWorkflow` active.
- `ready_to_merge`: node passed reviewer and judge.
- `queued_for_merge`: merge request submitted.
- `merged`: merge queue reported success.
- `failed` or `needs_human`: blocked.

Scheduling loop:

1. Compute ready nodes from DAG and current node states.
2. Respect `ParallelismConfig`.
3. Start child workflows for ready nodes.
4. Wait for any child completion, merge callback, approval update, or pause/cancel.
5. On child success, enqueue merge.
6. On child failure, mark node failed or needs human.
7. On merge success, mark node merged and unlock dependents.
8. At milestone boundary, run milestone review/judge.

Use `condition()` or deterministic Promise coordination to wait while paused or while no nodes are schedulable.

During execution, ordinary node-local failures are handled by the node repair loop. The root DAG scheduler should not patch the running graph in v0. If a finding cannot be repaired inside the current node's scope, the node returns a `GateFailureClassification`; `ambiguous`, `plan_gap`, and `spec_gap` classifications pause for human input unless they arise during milestone/final review where follow-up DAG generation is allowed.

When a human-requested follow-up DAG is accepted, the scheduler should stop launching newly ready nodes while the run is paused. Already-running nodes may continue only if not explicitly cancelled and if their output is still useful. Cancelled or skipped nodes remain auditable terminal states; replacement work must be represented by follow-up DAG nodes.

### 9.5 Node Execution Phase

`NodeExecutionWorkflow` state machine:

```text
PREPARING_WORKTREE
  -> CODING
  -> VERIFYING
  -> REVIEWING
  -> JUDGING
  -> PASSED_GATES
  -> READY_TO_MERGE

REVIEWING fail -> REPAIRING -> CODING
JUDGING fail -> REPAIRING -> CODING
VERIFYING fail -> REPAIRING -> CODING
max attempts exceeded -> NEEDS_HUMAN
cancel -> CLEANUP? -> CANCELLED
```

Attempt loop:

1. Create/reuse worktree.
2. Run coder Flue activity with:
   - node requirements
   - node markdown body
   - relevant SPEC sections
   - previous attempt summaries and checkpoint commits
   - current feedback from prior verification/review/judge
   - commands allowed
   - output schema
3. Run verification commands.
4. Create checkpoint commits as needed and collect final diff.
5. Commit the final node result to the node branch.
6. Run diff-scope validation against `expectedFiles`, `forbiddenFiles`, node kind, and milestone path policy.
7. Run reviewer Flue activity.
8. Run judge Flue activity.
9. If diff scope, reviewer, and judge pass, return `NodeReadyToMerge`.
10. If any gate fails inside node scope, construct `RepairInstruction`, append it to `NodeRunHistory`, and loop.
11. If any gate failure is outside node scope, classify it with `GateFailureClassification` and return `needs_human`.

Repair instruction must include:

- failing review findings
- failing judge findings
- exact required fixes
- files implicated
- tests to add or rerun
- what not to change

The repair loop should preserve the original node intent. It may add context, constraints, and required fixes to the next attempt, but it should not silently expand the node into unrelated work. If satisfying the judge requires additional independent work, the correct result in v0 is human escalation or a milestone/final follow-up DAG, not an oversized repair attempt.

### 9.6 Merge Queue Phase

The accepted v0 design is root-scoped serial merge. The global merge queue remains the production design once multiple factory runs may target the same repo/trunk concurrently.

#### v0 Simpler Design: Root-Scoped Serial Merge

The `FactoryRunWorkflow` serializes merges for its own run:

1. After a node passes gates, root starts `MergeNodeWorkflow`.
2. Root waits for merge completion before starting next merge.
3. Root marks node merged.

This is simpler but only serializes merges within one factory run. It does not prevent two factory runs against the same repo/trunk from racing. That limitation is acceptable for v0.

#### Production Design: Global Merge Queue Workflow

Use one long-lived `MergeQueueWorkflow` per repo/trunk:

```text
workflowId = merge-queue:<repoId>:<targetBranch>
```

It owns a FIFO queue:

```ts
interface MergeRequest {
  requestId: string;
  runWorkflowId: string;
  runId: RunId;
  nodeId: NodeId;
  repoId: RepoId;
  targetBranch: string;
  worktreePath: string;
  branchName: string;
  commitSha: string;
  gatedDiffUri: ArtifactUri;
  gatedDiffSha256: string;
  verificationPolicy: MergeVerificationPolicy;
}

interface MergeEnqueueResult {
  accepted: boolean;
  requestId: string;
  queuePosition?: number;
  duplicateOfRequestId?: string;
  rejectedReason?: string;
}
```

Root workflow enqueues via Update:

```text
Update MergeQueueWorkflow.enqueueMerge(MergeRequest) -> MergeEnqueueResult
```

`enqueueMerge` must validate the request ID, repo/trunk identity, gated commit SHA, queue capacity policy, and duplicate status before accepting. If the caller cannot wait for the final merge result, it should use `startUpdate(..., { waitForStage: 'ACCEPTED' })` and track the returned update handle/request ID.

Queue processes one item at a time:

1. Rebase/sync trunk.
2. Rebase node branch/worktree.
3. Compare the rebased diff against the gated diff.
4. If the effective diff changed due to conflict repair or rebase effects, return `requires_regate` so the node reruns verification, reviewer, and judge before merge.
5. Run pre-merge verification.
6. Merge or squash.
7. Run post-merge verification if configured.
8. Push trunk if configured.
9. Cleanup worktree.
10. Signal root workflow `mergeCompleted` or `mergeFailed` as an idempotent completion callback.
11. Continue-as-new periodically to keep history bounded.

Bootstrap:

- Application service ensures `MergeQueueWorkflow` exists before starting a factory run.
- Alternatively an Activity can start it through Temporal Client before root workflow enqueues.

Why not merge directly from node workflow:

- Two passed nodes can conflict after review.
- Trunk must be mutated serially.
- Cleanup and failure handling need durable ownership.
- Multiple factory runs may target the same trunk.

### 9.7 Milestone Review Phase

When every node in a milestone has merged or been explicitly skipped:

1. Run `MilestoneReviewWorkflow`.
2. Collect integrated diff since milestone start.
3. Collect relevant SPEC sections and plan requirements.
4. Run broad reviewer.
5. Run broad judge.
6. If both pass, mark milestone complete.
7. If either fails:
   - create `GapReport`
   - run `GapPlanningWorkflow`
   - generate a follow-up `PlanDAG`
   - approve or auto-approve per policy
   - execute the new or patched graph work
   - rerun milestone review

The broad reviewer should focus on cross-node integration bugs, missing tests, architecture drift, and regressions.

The broad judge should focus on whether the milestone as integrated satisfies the original SPEC and whether any node-level success masked missing work.

Milestone review is the primary place where new graph work is expected. Node-level gates should have already forced local defects to be fixed before merge. Broad findings should therefore describe integration gaps, missing plan coverage, or accepted work that must be extended by additional mergeable nodes. V0 does not restart or patch the already-executed graph; it appends follow-up DAG work or stops for human direction.

Human-requested follow-up DAGs are the exception to waiting for a milestone boundary. They are for cases where continuing the current graph would obviously waste compute or produce misleading work. They should be explicit, auditable operator actions through `requestFollowupDag`, not silent planner or agent decisions.

### 9.8 Final Acceptance Phase

After all milestones complete:

1. Run full-run broad review.
2. Run full-run judge.
3. Generate final report with:
   - SPEC satisfaction matrix
   - merged commits
   - test evidence
   - unresolved risks
   - follow-up recommendations
4. If final gates pass, complete workflow.
5. If final gates fail, generate final gap work or mark needs human according to policy.

## 10. Agent Prompt Contracts

### 10.1 Planner Contract

Input:

```ts
interface PlannerInput {
  spec: SpecDocument;
  repoContext: RepoContext;
  priorPlan?: PlanDAG;
  humanFeedback?: ApprovalComment[];
  desiredGranularity: 'small' | 'medium' | 'large';
  maxNodeCount?: number;
  parallelism: ParallelismConfig;
}
```

Output: `PlanDAG`.

Planner must:

- Produce a valid DAG.
- Produce or revise node and milestone markdown body artifacts.
- Prefer vertical slices that can be independently verified.
- Treat each node as one mergeable, reviewable, judgeable unit.
- Make edges explicit.
- Group nodes into milestones.
- Mark high-risk nodes.
- Include reviewer focus and judge rubric per node.
- Include verification commands.

### 10.2 Coder Contract

Input:

```ts
interface CoderInput {
  spec: SpecDocument;
  plan: PlanDAG;
  planSnapshot: PlanSnapshot;
  node: TaskNode;
  nodeBodyUri: ArtifactUri;
  repoContext: RepoContext;
  worktreePath: string;
  priorAttempts: NodeAttemptResult[];
  repairInstructions: RepairInstruction[];
}
```

Output: `NodeAttemptResult`.

Coder must:

- Work only on the node scope unless repair requires otherwise.
- Run relevant tests or explain skipped tests in structured output.
- Summarize changed files.
- Preserve prior repair context and directly address blocking findings.
- Avoid committing unrelated changes.
- Produce durable evidence for review and judgement.

### 10.3 Reviewer Contract

Input:

```ts
interface ReviewerInput {
  spec: SpecDocument;
  plan: PlanDAG;
  node: TaskNode;
  diffUri: ArtifactUri;
  changedFiles: string[];
  verificationResults: VerificationResult[];
}
```

Output: `ReviewReport`.

Reviewer must:

- Lead with blocking bugs.
- Distinguish blocker vs recommendation.
- Reference files and lines when possible.
- Fail if tests are meaningfully insufficient for the risk.
- Avoid spec-compliance judgement unless it creates a bug/risk.

### 10.4 Judge Contract

Input:

```ts
interface JudgeInput {
  spec: SpecDocument;
  plan: PlanDAG;
  node: TaskNode;
  diffUri: ArtifactUri;
  changedFiles: string[];
  attemptSummary: NodeAttemptResult;
  reviewReport?: ReviewReport;
}
```

Output: `JudgeReport`.

Judge must:

- Evaluate every node requirement.
- Identify partial or missing implementation.
- Identify shortcuts and corner cutting.
- Fail if acceptance criteria are not demonstrably met.
- Avoid inventing new requirements not in the SPEC or plan.

### 10.5 Gap Planner Contract

Input:

```ts
interface GapPlannerInput {
  spec: SpecDocument;
  currentPlan: PlanDAG;
  currentSnapshot: PlanSnapshot;
  milestone?: Milestone;
  gapReports: GapReport[];
  currentRepoState: RepoStateSummary;
}
```

Output: follow-up `PlanDAG`.

Gap planner must:

- Generate only tasks required to close gaps.
- Preserve traceability from gap IDs to new node IDs.
- Avoid undoing accepted work unless required.
- Add tests where gaps were caused by missing coverage.
- Append follow-up work instead of regenerating or patching the already-executed graph.

## 11. Git and Worktree Model

### 11.1 Worktree Naming

```text
<workspaceRoot>/factory-worktrees/<repoSlug>/<runId>/<nodeId>/<attemptId?>
```

Branch names:

```text
factory/<runId>/<nodeId>
factory/<runId>/<nodeId>/<attemptId>   // only if per-attempt branches are enabled
```

### 11.2 Node Worktree Lifecycle

V0 merge mode is direct local merge to trunk through the root-scoped serial merge path. Branch-and-PR mode is a later production path for protected repositories.

1. Create worktree from latest known trunk or milestone base.
2. Run coder and tests in worktree.
3. Commit changes.
4. Review and judge committed diff.
5. Repair in same worktree if failed.
6. Queue merge after gates pass.
7. Merge queue rebases before merging.
8. Cleanup worktree after merge.

### 11.2.1 Local Repository Safety Contract

Direct local merge is only acceptable in a trusted local workspace that satisfies one of these preflight modes:

1. Preferred: a dedicated factory clone with no user work in progress.
2. Allowed for development: an existing local checkout where `prepareTargetRepoActivity` stashes tracked and untracked local changes, creates the factory worktree from a clean target branch/base SHA, then restores the stash before agent execution continues.

Rules:

- The preflight activity must record target branch, starting trunk SHA, stash ref if any, worktree path, and repository cleanliness result.
- If the stash cannot be created, the worktree cannot be created, or stash restore would conflict, the run must stop in `NEEDS_HUMAN`.
- Agents must never receive the primary checkout as their cwd. They only receive factory-created worktrees.
- Merge activities must refuse to mutate trunk unless the merge workspace is clean, the target branch is the configured trunk, and the merge request's gated commit/diff matches the recorded gate artifacts.
- Cleanup must only delete factory-owned worktrees and branches. It must never drop or rewrite a user stash.
- Direct-to-trunk mode must remain local/trusted only. Protected shared repositories require branch-and-PR mode.

### 11.3 Merge Failure Handling

Merge can fail after node gates pass due to trunk changes.

Failure types:

- rebase conflict
- test failure after rebase
- push failure
- protected branch rejection
- post-merge verification failure

Handling:

1. Merge queue marks request failed with structured `MergeFailure`.
2. Factory run routes failure back to node as repair instruction.
3. Node reuses or recreates worktree from latest trunk.
4. Coder fixes conflict/test issue.
5. Reviewer and judge run again.
6. Node re-enters merge queue.

### 11.4 V0 Fixture Repository

The v0 fixture repository should be generated, deterministic, and disposable. It exists to exercise real git behavior without targeting the DuraFoundry implementation checkout.

Fixture defaults:

- Create under `.durafoundry/fixtures/<fixtureRepoId>/repo`.
- Initialize a real git repository with trunk branch `main`.
- Commit initial files:
  - `README.md`
  - `src/alpha.txt`
  - `src/beta.txt`
  - `test/fixture.test.txt`
- Generate two independent plan nodes:
  - `fixture-alpha`: edits `src/alpha.txt`.
  - `fixture-beta`: edits `src/beta.txt`.
- Fake reviewer or judge should fail one node exactly once, requiring a repair edit and rerun.
- Final trunk should contain both node edits and the repair edit.

Fixture cleanup must remove only factory-owned worktrees, branches, and fixture directories. The integration test should be able to preserve the fixture path on failure for debugging.

## 12. Parallelism

Parallelism is controlled at three layers.

### 12.1 DAG Parallelism

`ParallelismConfig.maxActiveNodes` limits active node workflows per run.

Additional controls:

- cap high-risk nodes
- cap per milestone
- cap per repo path prefix if file contention is common
- pause scheduling while merge queue backlog is too large

### 12.2 Temporal Worker Parallelism

Worker options control actual task execution capacity. Configure independently per task queue.

Example defaults for v0 development:

```ts
const orchestrationWorker = {
  taskQueue: 'factory-orchestrator',
  maxConcurrentWorkflowTaskExecutions: 40,
  maxConcurrentActivityTaskExecutions: 20,
};

const flueWorker = {
  taskQueue: 'factory-flue',
  maxConcurrentActivityTaskExecutions: 4,
  maxActivitiesPerSecond: 0.5,
};

const gitWorker = {
  taskQueue: 'factory-git',
  maxConcurrentActivityTaskExecutions: 2,
};

const ciWorker = {
  taskQueue: 'factory-ci',
  maxConcurrentActivityTaskExecutions: 4,
};
```

### 12.3 Merge Parallelism

Merge concurrency must be 1 per repo/trunk. Parallel pre-merge verification is allowed before entering the final merge critical section, but trunk mutation must be serialized.

## 13. UX Requirements

### 13.1 User Surfaces

Provide:

1. Web dashboard
2. HTTP API for automation and integrations
3. GitHub-hosted artifacts
4. Temporal Web UI compatibility
5. CLI/demo command for v0 local execution

### 13.2 CLI

V0 should ship a CLI path before the dashboard is complete. The CLI is an operator/demo surface over Temporal Client APIs and local fixture setup; it is not an agent runtime and must not bypass Workflow/Activity boundaries.

Initial CLI shape:

```text
durafoundry run \
  --spec docs/SPEC.md \
  --fixture-repo \
  --artifact-root .durafoundry \
  --task-queue factory-orchestrator \
  --temporal-address localhost:7233 \
  --auto-approve
```

The fixture mode should:

1. Create a generated throwaway git repository with a clean trunk branch.
2. Start or connect to the Temporal worker environment.
3. Start `FactoryRunWorkflow`.
4. Submit required approvals when running with `--auto-approve`.
5. Print run id, Temporal workflow id, artifact root, fixture repo path, node branch/commit links, and final status.

CLI flags:

| Flag | Required | Meaning |
| --- | --- | --- |
| `--spec <path>` | yes | Markdown SPEC file to load. |
| `--fixture-repo` | v0 yes | Generate and target a disposable fixture repo. |
| `--artifact-root <path>` | no | Local artifact root, default `.durafoundry`. |
| `--task-queue <name>` | no | Root workflow task queue, default `factory-orchestrator`. |
| `--temporal-address <host:port>` | no | Temporal address, default `TEMPORAL_ADDRESS` or `localhost:7233`. |
| `--auto-approve` | no | Automatically approve spec, plan, and low/medium follow-up DAG approvals for fixture/demo runs. |
| `--preserve-fixture` | no | Keep generated fixture repo and worktrees after failure for debugging. |

### 13.3 Control API

Initial HTTP API shape:

```text
POST /runs
GET /runs/:runId
GET /runs/:runId/events
POST /runs/:runId/spec-approvals
POST /runs/:runId/plan-approvals
GET /runs/:runId/nodes/:nodeId
POST /runs/:runId/nodes/:nodeId/retry-requests
POST /runs/:runId/gate-overrides
POST /runs/:runId/followup-dag-requests
POST /runs/:runId/parallelism
GET /runs/:runId/state-definitions
GET /runs/:runId/state-executions
POST /runs/:runId/state-retries
POST /runs/:runId/delays/:delayId/skip
POST /runs/:runId/pause
POST /runs/:runId/resume
```

These endpoints should call Temporal Client APIs and Temporal Updates. They are not agent execution paths and should not invoke any command-line agent runtime.

### 13.4 Dashboard Views

Dashboard must show:

- current run phase
- active state executions
- legal state transitions and reset boundaries
- approval requests
- DAG graph
- milestone lanes
- active nodes
- node attempts
- live Flue event stream
- review findings
- judge findings
- merge queue
- worktree/branch/commit links
- test results
- follow-up DAGs
- final SPEC satisfaction matrix
- state transition timeline

### 13.5 Approval UX

Approval screens should show:

- artifact version
- diff from prior version
- planner/spec-writer summary
- risks and assumptions
- structured feedback form
- approve/reject/request changes actions

Approvals should call Temporal Updates and display returned acknowledgement.

### 13.6 Observability

Use these layers:

1. Temporal UI: workflow status, history, child workflows, search attributes.
2. Factory dashboard: domain-specific DAG and gate state.
3. Flue event stream: tool/command/task progress.
4. External artifact store: transcripts, diffs, logs, test outputs.
5. Metrics: active runs, active nodes, attempt counts, review failure rate, judge failure rate, merge queue latency, gap plan count.

Operator tooling should expose iWF-inspired conveniences through native Temporal controls:

- skip a configured delay/backoff in test or operator mode
- retry from a named state execution when state policy permits
- show active state definitions and legal next states
- show why a state is waiting and which Update, Signal, timer, child workflow, or dependency can unblock it

Do not put raw token streams or full command logs in Workflow state. Store URIs.

## 14. Storage and Artifacts

Artifact types:

- SPEC versions
- Plan DAG versions
- Flue transcripts
- diffs
- command outputs
- verification reports
- review reports
- judge reports
- gap reports
- final report

Backends:

- Local filesystem for v0
- GitHub repo artifacts for human-facing spec/plan reports
- Object storage for production
- Optional relational DB for dashboard indexing

V0 local filesystem layout:

```text
.durafoundry/
  runs/<runId>/
  plans/<planId>/
    plan.json
    nodes/<nodeId>.md
    milestones/<milestoneId>.md
    snapshots/<snapshotId>.json
  artifacts/<artifactId>/
  fixtures/<fixtureRepoId>/
```

The local filesystem artifact store is authoritative for v0. Workflow state stores only artifact references, content hashes, compact status fields, and ids.

Every artifact should have:

```ts
interface ArtifactRef {
  uri: ArtifactUri;
  kind: string;
  sha256?: string;
  createdAt: string;
  producer: string;
}
```

## 15. Safety and Determinism Rules

Temporal Workflow code must:

- not call Flue directly
- not run git commands
- not read filesystem directly
- not call network APIs directly
- not use non-deterministic time/random except Temporal-safe APIs
- not store huge payloads or raw transcripts
- keep deterministic state transitions

Temporal Activities may:

- call Flue
- run commands
- call GitHub
- read/write filesystem
- run tests
- create worktrees
- merge branches

Flue agents must:

- receive least-privilege commands
- operate in assigned cwd
- produce schema-validated outputs
- provide evidence for claims
- never merge to trunk directly

Merge queue must:

- be the only component that mutates trunk
- rebase before merge when configured
- run required verification before merge
- cleanup after terminal result

## 16. Error Handling

### 16.1 Activity Retries

Use retry policies by category:

| Activity | Retry Policy |
| --- | --- |
| Flue agent call | limited retries for transport/model failures, not for judgement failure |
| Git command | retry only idempotent commands; no blind retry for conflicts |
| Verification command | no retry by default unless infrastructure failure detected |
| Merge push | retry transient remote failures; stop on branch protection or conflict |
| Cleanup | retry with backoff, then mark cleanup_failed |

### 16.2 Gate Failure Is Not Activity Failure

Reviewer or judge failure is a domain result, not a Temporal Activity failure.

The Activity should complete successfully with:

```ts
{ status: 'fail', findings: [...] }
```

Then workflow logic decides repair, human escalation, or override.

### 16.3 Human Escalation

Escalate to `NEEDS_HUMAN` when:

- max attempts reached
- reviewer/judge returns `needs_human`
- merge conflict repeats beyond threshold
- plan validation fails repeatedly
- broad review generates critical ambiguous gap
- Flue output repeatedly fails schema validation

Human can:

- add instructions
- approve override
- request new plan
- request an immediate follow-up DAG when continuing the current graph would waste cycles
- cancel node
- cancel run

## 17. Security and Permissions

Secrets:

- Flue commands should receive scoped env only when needed.
- `gh` tokens should be passed through `defineCommand`/command env, not written to prompt context.
- Codex subscription OAuth refresh/access tokens should be stored in the worker credential store or local Pi auth file and supplied to Flue only as the current provider `apiKey` override, never through prompt text.
- Agent prompts should not include secrets.
- Worktrees must avoid leaking credentials into diffs.

Command access:

- Coder: git, package manager, test commands, limited shell.
- Reviewer: read-only shell commands where possible.
- Judge: read-only shell commands where possible.
- Merge queue: git push/merge authority.

Repository protection:

- Prefer branch protection and PR mode for high-risk repos.
- Direct-to-trunk mode is acceptable for trusted local repos but should still go through merge queue.

## 18. Implementation Architecture

### 18.1 Package Layout Proposal

```text
apps/
  worker/
    src/
      workflows/
        factory-run.workflow.ts
        spec-iteration.workflow.ts
        plan-iteration.workflow.ts
        node-execution.workflow.ts
        merge-queue.workflow.ts
        milestone-review.workflow.ts
        gap-planning.workflow.ts
      activities/
        flue.activities.ts
        git.activities.ts
        verification.activities.ts
        artifact.activities.ts
        notification.activities.ts
      schemas/
        spec.schema.ts
        plan.schema.ts
        review.schema.ts
        judge.schema.ts
        run-state.schema.ts
      workers/
        orchestration.worker.ts
        flue.worker.ts
        git.worker.ts
        ci.worker.ts
  cli/
  web/
packages/
  domain/
  temporal-client/
  artifact-store/
  git-worktrees/
  flue-agents/
```

### 18.2 Workflow Registration

Use Temporal Worker with `workflowsPath` in development and prebuilt workflow bundle in production.

Worker code:

```ts
const worker = await Worker.create({
  taskQueue: 'factory-orchestrator',
  workflowsPath: require.resolve('./workflows'),
  activities: orchestrationActivities,
});
await worker.run();
```

Production should prebuild workflow bundle to avoid runtime bundling surprises.

### 18.3 Activity Routing

Workflow uses activity proxies with task queues:

```ts
const flue = proxyActivities<FlueActivities>({
  taskQueue: 'factory-flue',
  startToCloseTimeout: '30m',
  heartbeatTimeout: '30s',
  retry: { maximumAttempts: 2 },
});

const git = proxyActivities<GitActivities>({
  taskQueue: 'factory-git',
  startToCloseTimeout: '15m',
  retry: { maximumAttempts: 1 },
});

const ci = proxyActivities<VerificationActivities>({
  taskQueue: 'factory-ci',
  startToCloseTimeout: '60m',
  heartbeatTimeout: '30s',
  retry: { maximumAttempts: 1 },
});
```

### 18.4 Approval Handler Pattern

Inside workflow:

```ts
const submitPlanDecision = defineUpdate<PlanDecisionResult, [ApprovalDecision<PlanDAG>]>(
  'submitPlanDecision'
);
const getApprovalRequest = defineQuery<ApprovalRequest | undefined>('getApprovalRequest');

setHandler(submitPlanDecision, (decision) => {
  validateDecisionForCurrentPhase(decision, state);
  applyPlanDecision(state, decision);
  return { accepted: true, phase: state.phase };
});

setHandler(getApprovalRequest, () => state.pendingApproval);
```

Approval waiting:

```ts
state.pendingApproval = createPlanApproval(plan);
await condition(() => state.pendingApproval === undefined);
```

### 18.5 V0 Temporal Development Setup

Use two Temporal modes for v0:

1. Workflow tests use Temporal TypeScript's test environment with mocked or fixture-backed Activities.
2. CLI/demo runs connect to a local Temporal Server through `TEMPORAL_ADDRESS`, defaulting to `localhost:7233`.

The v0 CLI should fail fast with a clear setup message if it cannot connect to Temporal. It should not start a Temporal server implicitly. Documentation or scripts may provide a helper command for local Temporal startup, but the application boundary remains Temporal Client plus Workers.

Required local processes for the CLI/demo:

- Temporal Server reachable at `TEMPORAL_ADDRESS`.
- DuraFoundry Worker polling `factory-orchestrator` and Activity task queues.
- CLI process starting and observing a `FactoryRunWorkflow`.

## 19. Milestone Gap Loop

Milestone broad review/judge can append graph work after already-merged nodes have been evaluated as an integrated unit.

V0 approval policy for follow-up gap work is `high-risk-only`: low and medium risk follow-up DAG work may auto-run, while high or critical risk work requires explicit approval through `approveFollowupDag`.

The same follow-up DAG machinery may be triggered by a human `requestFollowupDag` Update before a milestone boundary. This path exists to stop wasteful execution after a human discovers a serious gap. It should pause scheduling by default, cancel only explicitly named nodes, and preserve all completed/merged node history.

High-risk approval is required when gap work:

- touches security-sensitive, data-loss-sensitive, or migration-heavy code
- changes public APIs, storage schemas, authentication, authorization, billing, or deployment behavior
- modifies broad architecture rather than localized implementation
- introduces or removes dependencies
- requires skipping or weakening verification
- is marked high or critical by broad reviewer, broad judge, or gap planner

Algorithm:

1. `MilestoneReviewWorkflow` returns `MilestoneGateResult`.
2. If pass, continue to next milestone.
3. If fail, create `GapReport`.
4. `GapPlanningWorkflow` converts gaps into a follow-up `PlanDAG` with `parentDagId`.
5. Validate follow-up DAG.
6. If policy requires approval, set pending approval and wait for `approveFollowupDag`.
7. Execute follow-up graph work with the same node lifecycle.
8. Rerun milestone gates.
9. Limit cycles with `maxGapCyclesPerMilestone`.

Human intervention algorithm:

1. Human submits `requestFollowupDag` with a `human_intervention` `GapReport`.
2. Workflow validates that the run is executing, paused, or needs human input.
3. Workflow pauses scheduling if requested.
4. Workflow cancels or skips only explicitly named nodes.
5. `GapPlanningWorkflow` converts the human gap into a follow-up `PlanDAG`.
6. Validate follow-up DAG.
7. Apply the same approval policy as milestone gap work.
8. Execute the follow-up DAG with the same node lifecycle.
9. Resume original schedulable work only after human approval or explicit resume policy.

Gap nodes should reference gap IDs:

```ts
interface FollowupTaskNode extends TaskNode {
  closesGapIds: string[];
  parentNodeIds?: NodeId[];
}
```

## 20. Testing Strategy

### 20.1 Unit Tests

Test:

- plan DAG validation
- plan snapshot hashing and stale approval rejection
- topological scheduler
- parallelism limits
- approval state transitions
- node gate decision logic
- gap plan generation validation
- merge queue FIFO ordering
- state definition validation
- legal transition enforcement
- operator retry/reset policy checks

### 20.2 Temporal Workflow Tests

Use Temporal TypeScript testing package to run workflow tests with mocked Activities.

Test:

- plan approval loops
- node repair loops
- reviewer fail then pass
- judge fail then pass
- node-local gate failures do not append graph work
- non-node-local gate failures escalate instead of patching the running graph
- max attempts escalation
- pause/resume
- cancellation cleanup scheduling
- milestone gap plan loop
- milestone finding creates approved follow-up graph work
- human follow-up DAG request pauses scheduling and cancels only selected nodes
- continue-as-new state carryover
- retry from named state execution
- skip delay/backoff in operator/test mode

### 20.3 Integration Tests

Use a generated throwaway fixture git repository:

- generate a real local git repository with a clean trunk branch
- create worktree
- run fake coder
- produce diff
- create node commit
- review/judge pass
- root-scoped merge queue merges with real git
- cleanup occurs
- state transition timeline is queryable
- CLI prints run id, workflow id, artifact root, fixture repo path, and final status

Then use real Flue in a controlled sample repo.

### 20.4 Replay Tests

Fetch workflow histories and replay after workflow code changes. This catches nondeterminism.

## 21. Open Design Decisions

### 21.1 Accepted Decisions

1. V0 implementation strategy: Temporal-first vertical slice.
   - Decision date: 2026-05-02.
   - Rationale: The highest-risk foundation is durable orchestration semantics plus the real repository mutation loop: approvals, DAG scheduling, repair loops, gate state, worktree creation, commits, merge serialization, cancellation, cleanup, and replay safety. Flue should be integrated behind Activity interfaces after those semantics are executable.
   - Consequence: Initial planner, coder, reviewer, and judge Activities may be fake or fixture-backed, but their input/output schemas must match the intended Flue-backed contracts. Git, artifact storage, worktree cleanup, and root-scoped serial merge should be real in v0 rather than mocked.

2. V0 merge strategy: root-scoped serial merge inside `FactoryRunWorkflow`.
   - Decision date: 2026-05-02.
   - Rationale: V0 optimizes for validating Temporal orchestration semantics quickly. A global `MergeQueueWorkflow` is only required when multiple factory runs may concurrently target the same repo/trunk.
   - Consequence: V0 serializes merges within a single run only. Production design still needs a repo/trunk-scoped global merge queue before supporting concurrent runs against one trunk.

3. V0 node merge mode: direct local merge to trunk.
   - Decision date: 2026-05-02.
   - Rationale: The Temporal-first prototype should validate durable orchestration, gate loops, worktree handling, and merge serialization without adding PR lifecycle complexity.
   - Consequence: V0 assumes a trusted local repository and target branch, with the local repository safety contract enforced before worktree creation and merge. A dedicated clone is preferred; a dirty local checkout is allowed only if local changes are stashed, the factory worktree is created from a clean base, and the stash is restored. Branch-and-PR mode remains required before operating on protected shared repositories.

4. V0 broad gap work approval policy: `high-risk-only`.
   - Decision date: 2026-05-02.
   - Rationale: Low and medium risk follow-up graph work should keep momentum after milestone review, but high/critical or architecture-changing repair work should pause for explicit human approval.
   - Consequence: `GapPlanningWorkflow` must classify gap work risk. `FactoryRunWorkflow` auto-runs low/medium gap work and waits for `approveFollowupDag` for high/critical gap work.

5. Reviewer and judge use different model policies.
   - Decision date: 2026-05-02.
   - Rationale: Review asks "is this buggy or under-tested?" Judgement asks "did this satisfy the spec without cutting corners?" Those failure modes should not be collapsed into one model pass.
   - Consequence: Role configuration must allow independent model selection for coder, reviewer, judge, broad reviewer, and broad judge. Stronger/fresher models are preferred for judge and broad judge.

6. Codex subscription support remains Flue/pi-ai-only, with no command-line agent fallback, using upstream Flue provider overrides.
   - Decision date: 2026-05-02.
   - Rationale: Flue already uses pi-ai, and pi-ai ships an `openai-codex` OAuth-backed provider for ChatGPT Plus/Pro Codex models. Keeping Codex inside Flue preserves sessions, tools, skills, typed results, event streaming, and sandbox control.
   - Consequence: Do not require private Flue patches for v0. DuraFoundry owns OAuth credential resolution in userland and passes the current access token through `init({ providers })`. Do not build or retain command-line agent adapters.

7. Use iWF as design inspiration only, not as a runtime dependency.
   - Decision date: 2026-05-02.
   - Rationale: iWF has strong ideas around explicit state definitions, wait/execute separation, RPC-style control, state reset, skip-timer tooling, and auto continue-as-new. But it would add another server, an interpreter workflow, REST callback semantics, and a Java/Go/Python SDK model that conflicts with the direct Temporal TypeScript design.
   - Consequence: Borrow iWF's explicit state-machine discipline and operator ergonomics, implemented with native Temporal Workflows, Activities, Updates, Queries, Search Attributes, and `continueAsNew`.

8. Plan artifacts are editable graphs; Temporal executes immutable snapshots.
   - Decision date: 2026-05-03.
   - Rationale: Users and planners need to iterate on a graph of tasks with substantial markdown context attached to each node, while Temporal needs stable deterministic input for scheduling, auditability, and stale approval rejection.
   - Consequence: `PlanDAG` is stored as part of a versioned plan artifact bundle. Approval creates a content-addressed `PlanSnapshotManifest`, and workflow execution references that snapshot. One node maps to one mergeable, reviewed, judged unit. Reviewer, judge, and verification failures normally repair the same node before merge; v0 does not patch the running graph. New graph work is appended through follow-up DAGs after milestone/final findings or explicit human direction through `requestFollowupDag`.

9. V0 ships through a CLI/demo path with a generated fixture repository and local filesystem artifacts.
   - Decision date: 2026-05-03.
   - Rationale: The first usable slice should exercise the real orchestration, artifact, and git lifecycle without risking a real target repository or waiting on dashboard work.
   - Consequence: The first execution plan should include `apps/cli`, generated fixture repo setup, local filesystem artifact storage, and a CLI command that starts a factory run and reports run status. The web dashboard can follow after the workflow, CLI, fixture, and local artifact loop are working.

### 21.2 Still Open

1. Should the orchestrator write generated SPEC revisions back to the same SPEC repo automatically?
   - Recommendation: yes, but only through an Activity and only after explicit approval.

2. Should Codex OAuth credentials remain in the local Pi auth file for v0 or be copied into a worker-owned credential store?
   - Recommendation: use the local Pi auth file for v0 through `packages/flue-runtime`, with Activities resolving the current access token and passing it to Flue through provider overrides. Revisit a worker-owned credential store before multi-user or hosted deployments.

3. Should Flue task child agents be used inside coder prompts?
   - Recommendation: allow for exploration but keep Temporal as the authoritative scheduler. Flue `task()` is for intra-node research, not global DAG orchestration.

4. Should node execution use a persistent Flue session across attempts?
   - Recommendation: yes for coder repair continuity, no for reviewer/judge independence.

## 22. Execution Plan Readiness

The SPEC is ready to convert into an execution plan when the planner targets the frozen v0 shape below. The first plan should not attempt the full product; it should build the durable factory loop with fake agent intelligence and real Temporal, filesystem artifact, and local git behavior.

Frozen v0 target:

- Temporal-first implementation using `FactoryRunWorkflow`, `PlanIterationWorkflow`, and `NodeExecutionWorkflow`.
- Fake or fixture-backed planner/coder/reviewer/judge/broad-reviewer/broad-judge Activities.
- Real local filesystem artifact store under `.durafoundry/`.
- Real generated fixture git repository with a clean trunk branch.
- Real git worktrees, commits, root-scoped serial merge, and cleanup.
- CLI/demo command as the first user-facing shipped path.
- No Flue/Codex dependency in the first vertical slice.
- No runtime graph patching. Follow-up graph work is appended as follow-up DAGs only.
- Human `requestFollowupDag` may stop wasteful execution and append follow-up DAG work.

Initial execution plan graph:

| Node | Title | Depends On | Acceptance |
| --- | --- | --- | --- |
| `v0-domain-schemas` | Implement executable domain schemas | none | TypeScript/Valibot schemas cover SPEC, plan, snapshot manifest, node attempts, review, judge, gap, and human gap request contracts. |
| `v0-artifact-store` | Implement local filesystem artifact store | `v0-domain-schemas` | Can write/read hashed artifacts and plan bundles under `.durafoundry/`; snapshot manifest hashes `plan.json`, node bodies, and milestone bodies. |
| `v0-fixture-repo` | Implement generated fixture git repository | `v0-domain-schemas` | Creates a clean local git repo with trunk, fixture files, and deterministic cleanup path. |
| `v0-git-activities` | Implement real git/worktree Activities | `v0-fixture-repo` | Can prepare repo, create worktree, commit node diff, merge serially, and cleanup factory-owned worktrees/branches. |
| `v0-fake-agent-activities` | Implement fake planner/coder/reviewer/judge Activities | `v0-domain-schemas`, `v0-artifact-store` | Fake planner writes plan bundle; fake coder edits fixture repo; fake gates can fail once then pass with structured reports. |
| `v0-workflows` | Implement Temporal workflows | `v0-artifact-store`, `v0-git-activities`, `v0-fake-agent-activities` | Plan approval, snapshot execution, DAG scheduling, node repair loop, serial merge, milestone pass, and human follow-up request states are durable and queryable. |
| `v0-cli` | Ship CLI/demo command | `v0-workflows`, `v0-fixture-repo` | `durafoundry run --spec docs/SPEC.md --fixture-repo --artifact-root .durafoundry` starts a run and prints workflow id, run id, fixture repo path, artifact root, commits, and final status. |
| `v0-tests` | Add workflow and integration tests | `v0-cli` | Tests cover plan approval, snapshot hashing, node repair, real git commit/merge/cleanup, human follow-up DAG request, and CLI fixture run. |

Planning rules for the first execution plan:

1. Keep node write scopes disjoint where possible: schemas/domain, artifact store, fixture/git, workflows, CLI/tests.
2. Implement schemas before workflow behavior that depends on them.
3. Implement artifact and git Activities before pretending the workflow is done.
4. Use a generated fixture repo for integration tests; do not target the DuraFoundry repo itself.
5. Keep Flue/Codex out of the initial graph except for preserving compatible Activity contracts.
6. Treat dashboard work as follow-up after CLI and Temporal query surfaces work.

## 23. First Implementation Slice

Build a minimal but real Temporal-first vertical slice:

1. Temporal project with `FactoryRunWorkflow`, `PlanIterationWorkflow`, `NodeExecutionWorkflow`.
2. Static approved SPEC loaded from local file.
3. Planner Activity returns a hand-authored or fake valid plan artifact bundle with `PlanDAG` plus node markdown bodies.
4. Plan approval Update creates `PlanSnapshot`.
5. Local filesystem artifact store writes plan bundles, snapshot manifests, diffs, command outputs, reports, and final report.
6. Fixture repo generator creates a throwaway real git repository with a clean trunk branch.
7. CLI command starts the factory run against the fixture repo and prints run status and artifact locations.
8. Execute two independent fake nodes from the approved snapshot with max parallelism 2.
9. Each node creates a real git worktree and runs a fake coder Activity that edits a file.
10. Reviewer and judge Activities return structured pass/fail.
11. On fail, fake coder repairs the same node and gates rerun.
12. Root-scoped serial merge uses real git to merge both nodes.
13. Milestone review returns pass.
14. HTTP API can query run state; dashboard can follow after v0 CLI path works.

Then replace fake planner/coder/reviewer/judge with Flue-backed Activities using existing upstream Flue capabilities and the model/provider path configured for the worker.

Keep the Codex subscription spike described in section 7.1.1 as a regression tool for the Flue-backed path. Do not make subscription Codex a prerequisite for the Temporal-first slice.

## 24. Acceptance Criteria for the Orchestrator

The orchestrator is acceptable when:

1. A SPEC can be approved through a Temporal Update.
2. A structured DAG plan artifact can be generated, validated, revised, snapshotted, and approved.
3. DAG nodes execute respecting dependencies and configurable parallelism.
4. Each code node can run in an isolated real git worktree.
5. The CLI can run the v0 flow against a generated fixture repository.
6. Local filesystem artifacts contain the plan bundle, snapshot manifest, diffs, command output, reports, and final report.
7. Review and judgement gates are separate and both must pass before merge.
8. Failed gates feed structured instructions back into repair attempts.
9. Merges are serialized and cleanup is durable.
10. Milestone broad review/judge or explicit human intervention can generate follow-up DAGs from gaps.
11. UX can observe status through Queries and artifacts without inspecting raw workflow history.
12. Workflow state is deterministic and side effects are confined to Activities.
