import {
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import type {
  CancelNodeUpdateInput,
  DagExecutionActivities,
  DagExecutionResult,
  DagExecutionWorkflowInput,
  DraftPlanResult,
  FactoryRunActivities,
  FactoryRunInput,
  FactoryRunState,
  GateOverrideUpdateInput,
  NodeExecutionActivities,
  NodeExecutionResult,
  NodeExecutionWorkflowInput,
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
import {
  applyDraftPlan,
  approveFollowupDagState,
  approvePlanState,
  cancelNodeState,
  createInitialFactoryRunState,
  executeDagScaffold,
  executeNodeScaffold,
  overrideGateState,
  pauseRunState,
  requestFollowupDagState,
  requestPlanChangesState,
  resumeRunState,
  retryFromStateScaffold,
  skipDelayScaffold,
  rejectPlanState,
} from './scaffold.js';

const activities = proxyActivities<FactoryRunActivities>({
  startToCloseTimeout: '1 minute',
});
const nodeActivities = proxyActivities<NodeExecutionActivities>({
  startToCloseTimeout: '5 minutes',
});
const dagActivities = proxyActivities<DagExecutionActivities>({
  startToCloseTimeout: '5 minutes',
});

export const getRunStateQuery = defineQuery<FactoryRunState>('getRunState');
export const approvePlanUpdate = defineUpdate<PlanDecisionResult, [PlanApprovalUpdateInput]>(
  'approvePlan',
);
export const rejectPlanUpdate = defineUpdate<PlanDecisionResult, [PlanApprovalUpdateInput]>(
  'rejectPlan',
);
export const requestPlanChangesUpdate = defineUpdate<
  PlanDecisionResult,
  [PlanApprovalUpdateInput]
>('requestPlanChanges');
export const pauseRunUpdate = defineUpdate<FactoryRunState, [string]>('pauseRun');
export const resumeRunUpdate = defineUpdate<FactoryRunState, [string]>('resumeRun');
export const cancelNodeUpdate = defineUpdate<FactoryRunState, [CancelNodeUpdateInput]>(
  'cancelNode',
);
export const overrideGateUpdate = defineUpdate<FactoryRunState, [GateOverrideUpdateInput]>(
  'overrideGate',
);
export const retryFromStateUpdate = defineUpdate<StateRetryResult, [StateRetryRequest]>(
  'retryFromState',
);
export const skipDelayUpdate = defineUpdate<SkipDelayResult, [SkipDelayRequest]>('skipDelay');
export const requestFollowupDagUpdate = defineUpdate<HumanGapResult, [HumanGapRequest]>(
  'requestFollowupDag',
);
export const approveFollowupDagUpdate = defineUpdate<PlanDecisionResult, [PlanApprovalUpdateInput]>(
  'approveFollowupDag',
);

export async function factoryRunWorkflow(input: FactoryRunInput): Promise<FactoryRunState> {
  let planDecisionMade = false;
  let draftPlan: DraftPlanResult | undefined;
  const state = createInitialFactoryRunState(input);

  setHandler(getRunStateQuery, () => state);
  setHandler(approvePlanUpdate, (approval) => {
    const result = approvePlanState(state, approval);
    planDecisionMade = result.accepted;
    return result;
  });
  setHandler(rejectPlanUpdate, (approval) => {
    const result = rejectPlanState(state, approval);
    planDecisionMade = result.accepted;
    return result;
  });
  setHandler(requestPlanChangesUpdate, (approval) => {
    const result = requestPlanChangesState(state, approval);
    planDecisionMade = result.accepted;
    return result;
  });
  setHandler(pauseRunUpdate, (reason) => pauseRunState(state, reason));
  setHandler(resumeRunUpdate, () => resumeRunState(state));
  setHandler(cancelNodeUpdate, (request) => cancelNodeState(state, request));
  setHandler(overrideGateUpdate, (request) => overrideGateState(state, request));
  setHandler(retryFromStateUpdate, (request: StateRetryRequest): StateRetryResult =>
    retryFromStateScaffold(request),
  );
  setHandler(skipDelayUpdate, (request: SkipDelayRequest): SkipDelayResult =>
    skipDelayScaffold(request),
  );
  setHandler(requestFollowupDagUpdate, (request: HumanGapRequest): HumanGapResult =>
    requestFollowupDagState(state, request),
  );
  setHandler(approveFollowupDagUpdate, (approval: PlanApprovalUpdateInput): PlanDecisionResult =>
    approveFollowupDagState(state, approval),
  );

  state.status = 'planning';
  draftPlan = await activities.createDraftPlan(input);
  applyDraftPlan(state, draftPlan);

  await condition(() => planDecisionMade);
  if (!isExecutingDagState(state)) {
    return state;
  }
  if (!input.runtime) {
    state.status = 'needs_human';
    state.latestFailureReason = 'Cannot execute DAG without fixture runtime inputs.';
    return state;
  }
  if (draftPlan.plan.mergePolicy.trunkBranch !== input.runtime.trunkBranch) {
    state.status = 'needs_human';
    state.latestFailureReason = `Runtime trunk branch ${input.runtime.trunkBranch} does not match approved plan trunk branch ${draftPlan.plan.mergePolicy.trunkBranch}.`;
    return state;
  }

  const dagResult = await executeDagScaffold(
    state,
    {
      plan: draftPlan.plan,
      repoPath: input.runtime.repoPath,
      worktreeRoot: input.runtime.worktreeRoot,
      artifactRoot: input.artifactRoot,
      gitAuthor: input.runtime.gitAuthor,
    },
    dagActivities,
  );
  return dagResult.state;
}

function isExecutingDagState(state: FactoryRunState): boolean {
  return state.status === 'executing_dag';
}

export async function nodeExecutionWorkflow(
  input: NodeExecutionWorkflowInput,
): Promise<NodeExecutionResult> {
  return executeNodeScaffold(input.factoryState, input.request, nodeActivities);
}

export async function dagExecutionWorkflow(
  input: DagExecutionWorkflowInput,
): Promise<DagExecutionResult> {
  return executeDagScaffold(input.factoryState, input.request, dagActivities);
}
