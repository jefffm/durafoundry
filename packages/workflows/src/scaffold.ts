import type {
  CancelNodeUpdateInput,
  DraftPlanResult,
  ExecuteNodeRequest,
  FactoryRunActivities,
  FactoryRunInput,
  FactoryRunState,
  GateOverrideUpdateInput,
  NodeAttemptRecord,
  NodeExecutionActivities,
  NodeExecutionResult,
  PlanApprovalUpdateInput,
  PlanDecisionResult,
} from './contracts.js';
import type {
  HumanGapRequest,
  HumanGapResult,
  NodeExecutionState,
  RepairInstruction,
  StateRetryRequest,
  StateRetryResult,
  SkipDelayRequest,
  SkipDelayResult,
} from '@durafoundry/domain';
import { validatePlanDAG, validatePlanSnapshotManifest } from '@durafoundry/domain';

export function createInitialFactoryRunState(input: FactoryRunInput): FactoryRunState {
  return {
    runId: input.runId,
    status: 'initializing',
    specUri: input.specUri,
    specSha256: input.specSha256,
    artifactRoot: input.artifactRoot,
    nodes: {},
    paused: false,
  };
}

export function applyDraftPlan(state: FactoryRunState, draft: DraftPlanResult): void {
  validateDraftPlanResult(draft);
  state.plan = {
    planId: draft.plan.planId,
    dagId: draft.plan.dagId,
    artifactUri: draft.planRef.uri,
    artifactSha256: draft.planRef.sha256,
    summary: draft.summary,
    status: draft.plan.status,
    snapshotId: draft.snapshotManifest.snapshotId,
    manifestUri: draft.snapshotManifestRef.uri,
    manifestSha256: draft.snapshotManifestRef.sha256,
  };
  state.nodes = Object.fromEntries(
    draft.plan.nodes.map((node) => [
      node.id,
      {
        nodeId: node.id,
        status: 'ready',
      },
    ]),
  );
  state.status = 'waiting_for_plan_approval';
}

export async function runFactoryRunScaffold(
  input: FactoryRunInput,
  activities: FactoryRunActivities,
): Promise<FactoryRunState> {
  const state = createInitialFactoryRunState(input);
  state.status = 'planning';
  applyDraftPlan(state, await activities.createDraftPlan(input));
  return state;
}

export async function executeNodeScaffold(
  state: FactoryRunState,
  request: ExecuteNodeRequest,
  activities: NodeExecutionActivities,
): Promise<NodeExecutionResult> {
  const snapshotId = state.approvedSnapshot?.snapshotId;
  if (!snapshotId) {
    const blocked = createInitialNodeExecutionState(request, 'needs_human');
    blocked.failureReason = 'Cannot execute node before a plan snapshot is approved.';
    updateNodeSummary(state, blocked);
    return toNodeExecutionResult(blocked, [], []);
  }

  const unsatisfiedDependencies = request.dependencyIds.filter(
    (dependencyId) => state.nodes[dependencyId]?.status !== 'merged',
  );
  if (unsatisfiedDependencies.length > 0) {
    const blocked = createInitialNodeExecutionState(request, 'blocked', snapshotId);
    blocked.failureReason = `Unsatisfied dependencies: ${unsatisfiedDependencies.join(', ')}`;
    updateNodeSummary(state, blocked);
    return toNodeExecutionResult(blocked, [], []);
  }

  const worktree = await activities.createNodeWorktree({
    repoPath: request.repoPath,
    trunkBranch: request.trunkBranch,
    worktreeRoot: request.worktreeRoot,
    runId: state.runId,
    nodeId: request.node.id,
    baseRef: request.node.worktree.baseRef,
  });

  const executionState = createInitialNodeExecutionState(request, 'running', snapshotId);
  executionState.worktreePath = worktree.worktreePath;
  executionState.branchName = worktree.branchName;
  updateNodeSummary(state, executionState);

  const attempts: NodeAttemptRecord[] = [];
  const allRepairInstructions: RepairInstruction[] = [];
  let pendingRepairInstructions: RepairInstruction[] = [];

  for (let attemptNumber = 1; attemptNumber <= request.node.maxAttempts; attemptNumber += 1) {
    const attemptId = `${request.node.id}-attempt-${attemptNumber}`;
    executionState.status = pendingRepairInstructions.length > 0 ? 'repairing' : 'running';
    executionState.activeAttemptId = attemptId;
    executionState.attemptIds.push(attemptId);
    updateNodeSummary(state, executionState);

    const attempt = await activities.runCoder({
      repoPath: worktree.worktreePath,
      nodeId: request.node.id,
      attemptId,
      planSnapshotId: snapshotId,
      artifactRoot: request.artifactRoot,
      repairInstructions: pendingRepairInstructions,
    });

    const verificationResults = [];
    let failedVerification:
      | Awaited<ReturnType<NodeExecutionActivities['runVerification']>>
      | undefined;
    const verificationCommands =
      request.node.verificationCommands.length > 0
        ? request.node.verificationCommands
        : ['verification skipped'];
    for (const command of verificationCommands) {
      const verification = await activities.runVerification({
        nodeId: request.node.id,
        attemptId,
        attemptNumber,
        worktreePath: worktree.worktreePath,
        command,
        repairInstructions: pendingRepairInstructions,
      });
      verificationResults.push(verification.result);
      if (verification.result.status !== 'passed') {
        failedVerification = verification;
        break;
      }
    }

    const attemptRecord: NodeAttemptRecord = {
      attempt: {
        ...attempt,
        testResults: mergeVerificationResults(attempt.testResults, verificationResults),
      },
      verification: verificationResults.at(-1) ?? {
        command: 'verification skipped',
        status: 'skipped',
        summary: 'No verification commands were configured.',
      },
      repairInstructions: [],
    };

    if (failedVerification) {
      attempts.push(attemptRecord);
      const terminal = handleRepairableFailure({
        state,
        executionState,
        attempts,
        allRepairInstructions,
        attemptRecord,
        newRepairInstructions: failedVerification.repairInstructions,
        failureReason: failedVerification.result.summary,
        attemptsRemaining: attemptNumber < request.node.maxAttempts,
      });
      if (terminal) {
        return terminal;
      }
      pendingRepairInstructions = failedVerification.repairInstructions;
      continue;
    }

    const commit = await activities.commitNodeChanges({
      worktreePath: worktree.worktreePath,
      nodeId: request.node.id,
      message: `DuraFoundry node ${request.node.id} attempt ${attemptNumber}`,
      author: request.gitAuthor,
      artifactRoot: request.artifactRoot,
    });
    attemptRecord.commit = commit;
    attemptRecord.attempt = {
      ...attemptRecord.attempt,
      changedFiles: dedupe([...attemptRecord.attempt.changedFiles, ...commit.changedFiles]),
      commandsRun: [...attemptRecord.attempt.commandsRun, ...commit.commandsRun],
      diffUri: commit.diffUri ?? attemptRecord.attempt.diffUri,
      checkpointCommits: dedupe([...attemptRecord.attempt.checkpointCommits, commit.commitSha]),
      commitSha: commit.commitSha,
    };
    executionState.latestDiffUri = attemptRecord.attempt.diffUri;
    executionState.checkpointCommits.push(commit.commitSha);

    executionState.status = 'awaiting_review';
    updateNodeSummary(state, executionState);
    const review = await activities.runReviewer({
      nodeId: request.node.id,
      attemptNumber,
      attemptId,
      commitSha: commit.commitSha,
      changedFiles: attemptRecord.attempt.changedFiles,
      diffUri: attemptRecord.attempt.diffUri,
      repairInstructions: pendingRepairInstructions,
    });
    attemptRecord.review = review.report;
    executionState.latestReview = review.report;

    if (review.report.status !== 'pass') {
      attempts.push(attemptRecord);
      const terminal = handleRepairableFailure({
        state,
        executionState,
        attempts,
        allRepairInstructions,
        attemptRecord,
        newRepairInstructions: review.repairInstructions,
        failureReason: review.report.summary,
        attemptsRemaining: attemptNumber < request.node.maxAttempts,
      });
      if (terminal) {
        return terminal;
      }
      pendingRepairInstructions = review.repairInstructions;
      continue;
    }

    executionState.status = 'awaiting_judgement';
    updateNodeSummary(state, executionState);
    const judgement = await activities.runJudge({
      nodeId: request.node.id,
      attemptNumber,
      attemptId,
      commitSha: commit.commitSha,
      changedFiles: attemptRecord.attempt.changedFiles,
      diffUri: attemptRecord.attempt.diffUri,
      repairInstructions: pendingRepairInstructions,
    });
    attemptRecord.judge = judgement.report;
    executionState.latestJudgement = judgement.report;

    if (judgement.report.status !== 'pass') {
      attempts.push(attemptRecord);
      const terminal = handleRepairableFailure({
        state,
        executionState,
        attempts,
        allRepairInstructions,
        attemptRecord,
        newRepairInstructions: judgement.repairInstructions,
        failureReason: judgement.report.summary,
        attemptsRemaining: attemptNumber < request.node.maxAttempts,
      });
      if (terminal) {
        return terminal;
      }
      pendingRepairInstructions = judgement.repairInstructions;
      continue;
    }

    attempts.push(attemptRecord);
    executionState.status = 'ready_to_merge';
    executionState.activeAttemptId = undefined;
    executionState.latestDiffUri = attemptRecord.attempt.diffUri;
    executionState.checkpointCommits = dedupe(executionState.checkpointCommits);
    executionState.failureReason = undefined;
    const result = toNodeExecutionResult(executionState, attempts, allRepairInstructions);
    state.nodeRuns = {
      ...(state.nodeRuns ?? {}),
      [request.node.id]: result,
    };
    updateNodeSummary(state, executionState);
    return result;
  }

  executionState.status = 'needs_human';
  executionState.activeAttemptId = undefined;
  executionState.failureReason = `Node ${request.node.id} exhausted ${request.node.maxAttempts} attempts.`;
  const result = toNodeExecutionResult(executionState, attempts, allRepairInstructions);
  state.nodeRuns = {
    ...(state.nodeRuns ?? {}),
    [request.node.id]: result,
  };
  updateNodeSummary(state, executionState);
  return result;
}

export function approvePlanState(
  state: FactoryRunState,
  approval: PlanApprovalUpdateInput,
): PlanDecisionResult {
  if (!state.plan) {
    return rejectDecision(state, 'No draft plan is available.');
  }
  if (state.status !== 'waiting_for_plan_approval') {
    return rejectDecision(state, `Run is not waiting for plan approval: ${state.status}`);
  }
  if (
    approval.planId !== state.plan.planId ||
    approval.artifactUri !== state.plan.artifactUri ||
    approval.artifactSha256 !== state.plan.artifactSha256
  ) {
    return rejectDecision(state, 'Approval does not match the current draft plan artifact.');
  }

  state.status = 'plan_approved';
  state.plan.status = 'approved';
  state.approvedSnapshot = Object.freeze({
    snapshotId: state.plan.snapshotId,
    planId: state.plan.planId,
    dagId: state.plan.dagId,
    planArtifactUri: state.plan.artifactUri,
    planArtifactSha256: state.plan.artifactSha256,
    manifestUri: state.plan.manifestUri,
    manifestSha256: state.plan.manifestSha256,
    approvedBy: approval.actor,
  });
  state.status = 'executing_dag';
  return { accepted: true, status: state.status };
}

export function rejectPlanState(
  state: FactoryRunState,
  approval: PlanApprovalUpdateInput,
): PlanDecisionResult {
  if (!state.plan || approval.planId !== state.plan.planId) {
    return rejectDecision(state, 'Rejection does not match the current draft plan.');
  }
  state.status = 'plan_rejected';
  return { accepted: true, status: state.status };
}

export function requestPlanChangesState(
  state: FactoryRunState,
  approval: PlanApprovalUpdateInput,
): PlanDecisionResult {
  if (!state.plan || approval.planId !== state.plan.planId) {
    return rejectDecision(state, 'Change request does not match the current draft plan.');
  }
  state.status = 'changes_requested';
  return { accepted: true, status: state.status };
}

export function pauseRunState(state: FactoryRunState, reason: string): FactoryRunState {
  state.paused = true;
  state.status = 'paused';
  state.latestFailureReason = reason;
  return state;
}

export function resumeRunState(state: FactoryRunState): FactoryRunState {
  state.paused = false;
  if (state.status === 'paused') {
    state.status = state.plan ? 'waiting_for_plan_approval' : 'planning';
  }
  return state;
}

export function cancelNodeState(
  state: FactoryRunState,
  request: CancelNodeUpdateInput,
): FactoryRunState {
  state.nodes[request.nodeId] = {
    nodeId: request.nodeId,
    status: 'cancelled',
    failureReason: request.reason,
  };
  return state;
}

export function overrideGateState(
  state: FactoryRunState,
  request: GateOverrideUpdateInput,
): FactoryRunState {
  state.latestFailureReason = `Gate override for ${request.targetId}: ${request.reason}`;
  return state;
}

export function retryFromStateScaffold(request: StateRetryRequest): StateRetryResult {
  return {
    accepted: false,
    rejectedReason: `State retry is not implemented in the scaffold: ${request.stateExecutionId}`,
  };
}

export function skipDelayScaffold(request: SkipDelayRequest): SkipDelayResult {
  return {
    accepted: false,
    rejectedReason: `Skip delay is not implemented in the scaffold: ${request.delayId}`,
  };
}

export function requestFollowupDagState(
  state: FactoryRunState,
  request: HumanGapRequest,
): HumanGapResult {
  state.requestedFollowup = request;
  if (request.pauseScheduling) {
    state.paused = true;
    state.status = 'paused';
  }
  return {
    accepted: true,
    runPaused: state.paused,
    cancelledNodeIds: request.cancelNodeIds ?? [],
    gapReportId: request.gapReport.gapReportId,
    pendingApproval: true,
  };
}

function rejectDecision(state: FactoryRunState, rejectedReason: string): PlanDecisionResult {
  state.latestFailureReason = rejectedReason;
  return {
    accepted: false,
    status: state.status,
    rejectedReason,
  };
}

function validateDraftPlanResult(draft: DraftPlanResult): void {
  const planResult = validatePlanDAG(draft.plan);
  if (!planResult.valid) {
    throw new Error(`Draft plan validation failed: ${planResult.errors.join('; ')}`);
  }

  const snapshotResult = validatePlanSnapshotManifest(draft.plan, draft.snapshotManifest);
  if (!snapshotResult.valid) {
    throw new Error(`Draft plan snapshot validation failed: ${snapshotResult.errors.join('; ')}`);
  }

  if (draft.snapshotManifest.planJson.uri !== draft.planRef.uri) {
    throw new Error('Draft plan snapshot does not reference the draft plan artifact.');
  }
}

function createInitialNodeExecutionState(
  request: ExecuteNodeRequest,
  status: NodeExecutionState['status'],
  planSnapshotId = 'unapproved',
): NodeExecutionState {
  return {
    nodeId: request.node.id,
    planSnapshotId,
    status,
    dependencyIds: request.dependencyIds,
    attemptIds: [],
    checkpointCommits: [],
  };
}

function updateNodeSummary(state: FactoryRunState, executionState: NodeExecutionState): void {
  state.nodes[executionState.nodeId] = {
    nodeId: executionState.nodeId,
    status: executionState.status,
    failureReason: executionState.failureReason,
  };
}

function toNodeExecutionResult(
  executionState: NodeExecutionState,
  attempts: NodeAttemptRecord[],
  repairInstructions: RepairInstruction[],
): NodeExecutionResult {
  const history = {
    nodeId: executionState.nodeId,
    planSnapshotId: executionState.planSnapshotId,
    attemptIds: attempts.map((attempt) => attempt.attempt.attemptId),
    reviewReportIds: attempts.flatMap((attempt) =>
      attempt.review ? [attempt.review.reportId] : [],
    ),
    judgeReportIds: attempts.flatMap((attempt) =>
      attempt.judge ? [attempt.judge.reportId] : [],
    ),
    repairInstructions,
    finalGatedCommitSha:
      executionState.status === 'ready_to_merge'
        ? attempts.at(-1)?.commit?.commitSha
        : undefined,
  };

  return {
    state: executionState,
    history,
    attempts,
    appendedGraphWork: false,
  };
}

function handleRepairableFailure(input: {
  state: FactoryRunState;
  executionState: NodeExecutionState;
  attempts: NodeAttemptRecord[];
  allRepairInstructions: RepairInstruction[];
  attemptRecord: NodeAttemptRecord;
  newRepairInstructions: RepairInstruction[];
  failureReason: string;
  attemptsRemaining: boolean;
}): NodeExecutionResult | undefined {
  input.attemptRecord.repairInstructions = input.newRepairInstructions;
  input.allRepairInstructions.push(...input.newRepairInstructions);

  const nodeLocal =
    input.newRepairInstructions.length > 0 &&
    input.newRepairInstructions.every(
      (instruction) =>
        instruction.nodeId === input.executionState.nodeId &&
        instruction.scope === 'node_local',
    );
  if (!nodeLocal || !input.attemptsRemaining) {
    input.executionState.status = 'needs_human';
    input.executionState.activeAttemptId = undefined;
    input.executionState.failureReason = !nodeLocal
      ? `Gate produced out-of-scope work for ${input.executionState.nodeId}: ${input.failureReason}`
      : `Node ${input.executionState.nodeId} exhausted attempts: ${input.failureReason}`;
    const result = toNodeExecutionResult(
      input.executionState,
      input.attempts,
      input.allRepairInstructions,
    );
    input.state.nodeRuns = {
      ...(input.state.nodeRuns ?? {}),
      [input.executionState.nodeId]: result,
    };
    updateNodeSummary(input.state, input.executionState);
    return result;
  }

  input.executionState.status = 'repairing';
  input.executionState.activeAttemptId = undefined;
  input.executionState.failureReason = input.failureReason;
  updateNodeSummary(input.state, input.executionState);
  return undefined;
}

function mergeVerificationResults(
  existing: NodeAttemptRecord['attempt']['testResults'],
  latest: NodeAttemptRecord['attempt']['testResults'],
): NodeAttemptRecord['attempt']['testResults'] {
  const latestCommands = new Set(latest.map((result) => result.command));
  return [...existing.filter((result) => !latestCommands.has(result.command)), ...latest];
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
