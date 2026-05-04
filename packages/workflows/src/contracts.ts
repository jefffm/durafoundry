import type {
  ArtifactRef,
  CommandResult,
  GapReport,
  HumanGapRequest,
  HumanGapResult,
  JudgeReport,
  NodeId,
  NodeAttemptResult,
  NodeExecutionState,
  NodeRunHistory,
  PlanDAG,
  PlanSnapshotManifest,
  RepairInstruction,
  ReviewReport,
  StateRetryRequest,
  StateRetryResult,
  SkipDelayRequest,
  SkipDelayResult,
  TaskNode,
  VerificationResult,
} from '@durafoundry/domain';

export type FactoryRunStatus =
  | 'initializing'
  | 'planning'
  | 'waiting_for_plan_approval'
  | 'plan_approved'
  | 'executing_dag'
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
  runtime?: FactoryRunRuntimeInput;
}

export interface FactoryRunRuntimeInput {
  repoPath: string;
  trunkBranch: string;
  worktreeRoot: string;
  gitAuthor: GitAuthorRef;
}

export interface DraftPlanResult {
  plan: PlanDAG;
  planRef: ArtifactRef;
  snapshotManifest: PlanSnapshotManifest;
  snapshotManifestRef: ArtifactRef;
  summary: string;
}

export interface FactoryRunActivities {
  createDraftPlan(input: FactoryRunInput): Promise<DraftPlanResult>;
}

export interface NodeExecutionActivities {
  createNodeWorktree(input: CreateNodeWorktreeActivityInput): Promise<NodeWorktreeRef>;
  runCoder(input: RunCoderActivityInput): Promise<NodeAttemptResult>;
  runVerification(input: RunVerificationActivityInput): Promise<NodeVerificationGateResult>;
  commitNodeChanges(input: CommitNodeChangesActivityInput): Promise<NodeCommitResult>;
  runReviewer(input: RunGateActivityInput): Promise<NodeReviewGateResult>;
  runJudge(input: RunGateActivityInput): Promise<NodeJudgeGateResult>;
}

export interface DagExecutionActivities extends NodeExecutionActivities {
  mergeNodeCommit(input: MergeNodeCommitActivityInput): Promise<MergeNodeCommitResult>;
  cleanupNodeWorktree(input: CleanupNodeWorktreeActivityInput): Promise<CleanupNodeWorktreeResult>;
  runBroadReviewer(input: RunBroadGateActivityInput): Promise<BroadReviewGateResult>;
  runBroadJudge(input: RunBroadGateActivityInput): Promise<BroadJudgeGateResult>;
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
    snapshotId: string;
    manifestUri: string;
    manifestSha256?: string;
  };
  approvedSnapshot?: ApprovedPlanSnapshotRef;
  nodes: Record<NodeId, NodeStateSummary>;
  nodeRuns?: Record<NodeId, NodeExecutionResult>;
  latestFailureReason?: string;
  paused: boolean;
  statusBeforePause?: FactoryRunStatus;
  requestedFollowup?: HumanGapRequest;
  followupDag?: FollowupDagState;
}

export interface NodeStateSummary {
  nodeId: NodeId;
  status: NodeExecutionState['status'] | 'cancelled';
  failureReason?: string;
}

export interface ApprovedPlanSnapshotRef {
  snapshotId: string;
  planId: string;
  dagId: string;
  planArtifactUri: string;
  planArtifactSha256?: string;
  manifestUri: string;
  manifestSha256?: string;
  approvedBy: string;
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

export interface FollowupDagDraftResult extends DraftPlanResult {
  approvalPolicy: 'always' | 'high-risk-only' | 'never';
}

export interface FollowupDagState {
  requestId: string;
  gapReportId: string;
  planId: string;
  dagId: string;
  parentDagId: string;
  parentSnapshotId: string;
  snapshotId: string;
  artifactUri: string;
  artifactSha256?: string;
  manifestUri: string;
  manifestSha256?: string;
  status: 'waiting_for_approval' | 'approved' | 'executing' | 'completed';
  requiresApproval: boolean;
  highRiskNodeIds: NodeId[];
  cancelledNodeIds: NodeId[];
  skippedNodeIds: NodeId[];
}

export interface ExecuteNodeRequest {
  node: TaskNode;
  dependencyIds: NodeId[];
  repoPath: string;
  trunkBranch: string;
  worktreeRoot: string;
  artifactRoot: string;
  gitAuthor: GitAuthorRef;
}

export interface NodeExecutionWorkflowInput {
  factoryState: FactoryRunState;
  request: ExecuteNodeRequest;
}

export interface GitAuthorRef {
  name: string;
  email: string;
}

export interface CreateNodeWorktreeActivityInput {
  repoPath: string;
  trunkBranch: string;
  worktreeRoot: string;
  runId: string;
  nodeId: NodeId;
  baseRef?: string;
}

export interface NodeWorktreeRef {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  baseCommitSha: string;
}

export interface RunCoderActivityInput {
  repoPath: string;
  nodeId: NodeId;
  attemptId: string;
  planSnapshotId: string;
  artifactRoot: string;
  repairInstructions?: RepairInstruction[];
}

export interface RunVerificationActivityInput {
  nodeId: NodeId;
  attemptId: string;
  attemptNumber: number;
  worktreePath: string;
  command: string;
  repairInstructions: RepairInstruction[];
}

export interface NodeVerificationGateResult {
  result: VerificationResult;
  repairInstructions: RepairInstruction[];
}

export interface CommitNodeChangesActivityInput {
  worktreePath: string;
  nodeId: NodeId;
  message: string;
  author: GitAuthorRef;
  artifactRoot: string;
}

export interface NodeCommitResult {
  worktreePath: string;
  branchName: string;
  commitSha: string;
  changedFiles: string[];
  diffUri?: string;
  commandsRun: CommandResult[];
}

export interface RunGateActivityInput {
  nodeId: NodeId;
  attemptNumber: number;
  attemptId: string;
  commitSha: string;
  changedFiles: string[];
  diffUri?: string;
  repairInstructions: RepairInstruction[];
}

export interface NodeReviewGateResult {
  report: ReviewReport;
  repairInstructions: RepairInstruction[];
}

export interface NodeJudgeGateResult {
  report: JudgeReport;
  repairInstructions: RepairInstruction[];
}

export interface NodeAttemptRecord {
  attempt: NodeAttemptResult;
  verification: VerificationResult;
  commit?: NodeCommitResult;
  review?: ReviewReport;
  judge?: JudgeReport;
  repairInstructions: RepairInstruction[];
}

export interface NodeExecutionResult {
  state: NodeExecutionState;
  history: NodeRunHistory;
  attempts: NodeAttemptRecord[];
  appendedGraphWork: false;
}

export interface ExecuteDagRequest {
  plan: PlanDAG;
  repoPath: string;
  worktreeRoot: string;
  artifactRoot: string;
  gitAuthor: GitAuthorRef;
}

export interface DagExecutionWorkflowInput {
  factoryState: FactoryRunState;
  request: ExecuteDagRequest;
}

export interface MergeNodeCommitActivityInput {
  repoPath: string;
  trunkBranch: string;
  branchName: string;
  author: GitAuthorRef;
  expectedCommitSha?: string;
}

export interface MergeNodeCommitResult {
  repoPath: string;
  trunkBranch: string;
  branchName: string;
  mergedCommitSha: string;
  trunkHeadBefore: string;
  trunkHeadAfter: string;
  commandsRun: CommandResult[];
}

export interface CleanupNodeWorktreeActivityInput {
  repoPath: string;
  worktreePath: string;
  runId: string;
  nodeId?: NodeId;
  branchName?: string;
  removeBranch?: boolean;
}

export interface CleanupNodeWorktreeResult {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  removedWorktree: boolean;
  removedBranch: boolean;
  commandsRun: CommandResult[];
  failureReason?: string;
}

export interface RunBroadGateActivityInput {
  milestoneId: string;
  mergedNodeIds: NodeId[];
  repoPath: string;
}

export interface BroadReviewGateResult {
  report: ReviewReport;
  gapReport?: GapReport;
}

export interface BroadJudgeGateResult {
  report: JudgeReport;
  gapReport?: GapReport;
}

export interface MilestoneGateResult {
  milestoneId: string;
  review?: ReviewReport;
  judge?: JudgeReport;
  gapReports: GapReport[];
}

export interface MergedNodeResult {
  nodeId: NodeId;
  merge: MergeNodeCommitResult;
  cleanup?: CleanupNodeWorktreeResult;
}

export interface DagExecutionResult {
  state: FactoryRunState;
  nodeResults: Record<NodeId, NodeExecutionResult>;
  mergedNodes: MergedNodeResult[];
  cleanupResults: CleanupNodeWorktreeResult[];
  milestoneResults: MilestoneGateResult[];
  maxObservedActiveNodes: number;
  maxObservedActiveHighRiskNodes: number;
  maxObservedMergeConcurrency: number;
}
