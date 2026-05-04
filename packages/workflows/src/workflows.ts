import {
  CancellationScope,
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
  FollowupDagDraftResult,
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
  PlanDAG,
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
  heartbeatTimeout: '5 seconds',
  retry: { maximumAttempts: 1 },
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
    requestFollowupDagState(
      state,
      request,
      draftPlan && state.approvedSnapshot
        ? createFollowupDagDraft(draftPlan.plan, state, request)
        : undefined,
    ),
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
    {
      waitWhilePaused: async () => {
        await condition(() => !state.paused);
      },
      runCleanup: (operation) => CancellationScope.nonCancellable(operation),
    },
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

function createFollowupDagDraft(
  parentPlan: PlanDAG,
  state: FactoryRunState,
  request: HumanGapRequest,
): FollowupDagDraftResult {
  const suffix = safePlanSegment(request.requestId);
  const nodeId = `followup-${suffix}`;
  const milestoneId = `followup-milestone-${suffix}`;
  const createdAt = parentPlan.createdAt;
  const planUri = `file:///followup-${suffix}.json`;
  const nodeBodyUri = `file:///followup-${suffix}.md`;
  const milestoneBodyUri = `file:///followup-milestone-${suffix}.md`;
  const manifestUri = `file:///followup-${suffix}-snapshot.json`;
  const plan: PlanDAG = {
    planId: `followup-plan-${suffix}`,
    dagId: `followup-dag-${suffix}`,
    parentDagId: state.approvedSnapshot?.dagId,
    parentSnapshotId: state.approvedSnapshot?.snapshotId,
    specId: parentPlan.specId,
    specVersion: parentPlan.specVersion,
    createdAt,
    plannerModel: 'durafoundry-control-update',
    status: 'proposed',
    artifactUri: planUri,
    summary: `Follow-up DAG for ${request.gapReport.gapReportId}`,
    assumptions: [`Requested by ${request.actor}: ${request.reason}`],
    milestones: [
      {
        id: milestoneId,
        title: 'Follow-up work',
        description: request.gapReport.summary,
        bodyUri: milestoneBodyUri,
        nodeIds: [nodeId],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['Address the reported follow-up gap.'],
      },
    ],
    nodes: [
      {
        id: nodeId,
        milestoneId,
        title: 'Address follow-up gap',
        kind: 'code',
        bodyUri: nodeBodyUri,
        description: request.gapReport.summary,
        requirements: request.gapReport.gaps.flatMap((gap) => gap.suggestedTasks),
        specRequirementIds: request.gapReport.gaps.flatMap((gap) => gap.affectedRequirements),
        acceptanceCriteria: ['The reported gap is resolved or explicitly accepted.'],
        verificationCommands: ['verification skipped'],
        reviewerFocus: ['Confirm the follow-up gap is addressed.'],
        judgeRubric: ['No unresolved blocking gap remains.'],
        riskLevel: request.requiresApprovalOverride ? 'high' : 'medium',
        worktree: {
          mode: 'per-node',
          baseRef: parentPlan.mergePolicy.trunkBranch,
          cleanup: 'after-merge',
        },
        maxAttempts: 2,
      },
    ],
    edges: [],
    globalAcceptanceCriteria: ['Follow-up DAG resolves the gap request.'],
    parallelism: parentPlan.parallelism,
    mergePolicy: parentPlan.mergePolicy,
  };

  return {
    approvalPolicy: 'always',
    summary: plan.summary,
    plan,
    planRef: {
      uri: planUri,
      kind: 'plan-json',
      sha256: `followup-plan-sha-${suffix}`,
      createdAt,
      producer: 'durafoundry-control-update',
    },
    snapshotManifest: {
      snapshotId: `followup-snapshot-${suffix}`,
      planJson: {
        uri: planUri,
        sha256: `followup-plan-sha-${suffix}`,
        kind: 'plan-json',
      },
      nodeBodies: {
        [nodeId]: {
          uri: nodeBodyUri,
          sha256: `followup-node-sha-${suffix}`,
          kind: 'node-body',
        },
      },
      milestoneBodies: {
        [milestoneId]: {
          uri: milestoneBodyUri,
          sha256: `followup-milestone-sha-${suffix}`,
          kind: 'milestone-body',
        },
      },
      createdAt,
    },
    snapshotManifestRef: {
      uri: manifestUri,
      kind: 'plan-snapshot-manifest',
      sha256: `followup-manifest-sha-${suffix}`,
      createdAt,
      producer: 'durafoundry-control-update',
    },
  };
}

function safePlanSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.length > 0 ? safe : 'request';
}
