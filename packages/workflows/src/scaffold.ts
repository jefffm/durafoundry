import type {
  CancelNodeUpdateInput,
  DraftPlanResult,
  FactoryRunActivities,
  FactoryRunInput,
  FactoryRunState,
  GateOverrideUpdateInput,
  PlanApprovalUpdateInput,
  PlanDecisionResult,
} from './contracts.js';
import type {
  HumanGapRequest,
  HumanGapResult,
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
