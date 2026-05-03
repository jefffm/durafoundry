import type {
  ArtifactRef,
  HumanGapRequest,
  HumanGapResult,
  NodeId,
  PlanDAG,
  StateRetryRequest,
  StateRetryResult,
  SkipDelayRequest,
  SkipDelayResult,
} from '@durafoundry/domain';

export type FactoryRunStatus =
  | 'initializing'
  | 'planning'
  | 'waiting_for_plan_approval'
  | 'plan_approved'
  | 'plan_rejected'
  | 'changes_requested'
  | 'paused'
  | 'completed'
  | 'needs_human'
  | 'failed';

export interface FactoryRunInput {
  runId: string;
  specUri: string;
  specSha256: string;
  artifactRoot: string;
}

export interface DraftPlanResult {
  plan: PlanDAG;
  planRef: ArtifactRef;
  summary: string;
}

export interface FactoryRunActivities {
  createDraftPlan(input: FactoryRunInput): Promise<DraftPlanResult>;
}

export interface FactoryRunState {
  runId: string;
  status: FactoryRunStatus;
  specUri: string;
  specSha256: string;
  artifactRoot: string;
  plan?: {
    planId: string;
    dagId: string;
    artifactUri: string;
    artifactSha256?: string;
    summary: string;
    status: PlanDAG['status'];
  };
  nodes: Record<NodeId, NodeStateSummary>;
  latestFailureReason?: string;
  paused: boolean;
  requestedFollowup?: HumanGapRequest;
}

export interface NodeStateSummary {
  nodeId: NodeId;
  status: 'blocked' | 'ready' | 'running' | 'cancelled' | 'skipped' | 'needs_human';
  failureReason?: string;
}

export interface PlanApprovalUpdateInput {
  planId: string;
  artifactUri: string;
  artifactSha256?: string;
  actor: string;
}

export interface PlanDecisionResult {
  accepted: boolean;
  status: FactoryRunStatus;
  rejectedReason?: string;
}

export interface CancelNodeUpdateInput {
  nodeId: NodeId;
  reason: string;
}

export interface GateOverrideUpdateInput {
  targetId: string;
  reason: string;
}
