import * as v from 'valibot';

export const IsoTimestampSchema = v.string();
export const RunIdSchema = v.string();
export const SpecIdSchema = v.string();
export const SpecVersionSchema = v.string();
export const PlanIdSchema = v.string();
export const DagIdSchema = v.string();
export const NodeIdSchema = v.string();
export const MilestoneIdSchema = v.string();
export const AttemptIdSchema = v.string();
export const ArtifactUriSchema = v.string();
export const RepoIdSchema = v.string();
export const PlanSnapshotIdSchema = v.string();
export const FactoryStateIdSchema = v.string();
export const StateExecutionIdSchema = v.string();
export const DelayIdSchema = v.string();

export const ArtifactRefSchema = v.object({
  uri: ArtifactUriSchema,
  kind: v.string(),
  sha256: v.optional(v.string()),
  createdAt: IsoTimestampSchema,
  producer: v.string(),
});

export const RequirementPrioritySchema = v.picklist(['must', 'should', 'could']);
export const ConstraintKindSchema = v.picklist([
  'technical',
  'product',
  'security',
  'performance',
  'compatibility',
  'process',
]);
export const AcceptanceVerificationSchema = v.picklist([
  'test',
  'review',
  'manual',
  'static-analysis',
  'runtime-check',
]);
export const SeveritySchema = v.picklist(['low', 'medium', 'high', 'critical']);
export const NodeRiskLevelSchema = SeveritySchema;

export const RequirementSchema = v.object({
  id: v.string(),
  text: v.string(),
  priority: RequirementPrioritySchema,
  source: v.optional(v.string()),
});

export const ConstraintSchema = v.object({
  id: v.string(),
  text: v.string(),
  kind: ConstraintKindSchema,
});

export const AcceptanceCriterionSchema = v.object({
  id: v.string(),
  text: v.string(),
  verification: AcceptanceVerificationSchema,
});

export const RiskSchema = v.object({
  id: v.string(),
  text: v.string(),
  severity: SeveritySchema,
  mitigation: v.optional(v.string()),
});

export const OpenQuestionSchema = v.object({
  id: v.string(),
  text: v.string(),
  blocking: v.boolean(),
});

export const RepoTargetSchema = v.object({
  repoId: RepoIdSchema,
  cloneUrl: v.string(),
  trunkBranch: v.string(),
  packageManager: v.optional(v.string()),
  testCommands: v.array(v.string()),
});

export const SpecDocumentSchema = v.object({
  specId: SpecIdSchema,
  version: SpecVersionSchema,
  title: v.string(),
  sourceUri: ArtifactUriSchema,
  createdAt: IsoTimestampSchema,
  author: v.string(),
  status: v.picklist(['draft', 'proposed', 'approved', 'superseded', 'rejected']),
  problemStatement: v.string(),
  goals: v.array(v.string()),
  nonGoals: v.array(v.string()),
  requirements: v.array(RequirementSchema),
  constraints: v.array(ConstraintSchema),
  acceptanceCriteria: v.array(AcceptanceCriterionSchema),
  risks: v.array(RiskSchema),
  openQuestions: v.array(OpenQuestionSchema),
  targetRepo: RepoTargetSchema,
});

export const WorktreePolicySchema = v.object({
  mode: v.picklist(['none', 'per-node', 'per-attempt']),
  baseRef: v.string(),
  cleanup: v.picklist(['after-merge', 'after-run', 'manual']),
});

export const MergePolicySchema = v.object({
  mode: v.picklist(['direct-to-trunk', 'branch-and-pr', 'local-only']),
  trunkBranch: v.string(),
  requireGreenVerification: v.boolean(),
  rebaseBeforeMerge: v.boolean(),
  squash: v.boolean(),
});

export const MilestoneReviewPolicySchema = v.object({
  runBroadReview: v.boolean(),
  runBroadJudge: v.boolean(),
  autoPlanGaps: v.boolean(),
  requireApprovalForGapWork: v.picklist(['always', 'high-risk-only', 'never']),
});

export const ParallelismConfigSchema = v.object({
  maxActiveNodes: v.number(),
  maxActiveHighRiskNodes: v.number(),
  maxActivePerMilestone: v.optional(v.number()),
  mergeConcurrency: v.literal(1),
});

export const MilestoneSchema = v.object({
  id: MilestoneIdSchema,
  title: v.string(),
  bodyUri: v.optional(ArtifactUriSchema),
  description: v.string(),
  nodeIds: v.array(NodeIdSchema),
  reviewPolicy: MilestoneReviewPolicySchema,
  acceptanceCriteria: v.array(v.string()),
});

export const TaskNodeSchema = v.object({
  id: NodeIdSchema,
  milestoneId: MilestoneIdSchema,
  title: v.string(),
  kind: v.picklist(['code', 'test', 'docs', 'migration', 'analysis', 'cleanup']),
  bodyUri: ArtifactUriSchema,
  description: v.string(),
  requirements: v.array(v.string()),
  specRequirementIds: v.array(v.string()),
  acceptanceCriteria: v.array(v.string()),
  expectedFiles: v.optional(v.array(v.string())),
  forbiddenFiles: v.optional(v.array(v.string())),
  verificationCommands: v.array(v.string()),
  reviewerFocus: v.array(v.string()),
  judgeRubric: v.array(v.string()),
  riskLevel: NodeRiskLevelSchema,
  worktree: WorktreePolicySchema,
  maxAttempts: v.number(),
});

export const DagEdgeSchema = v.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  reason: v.string(),
});

export const PlanDAGSchema = v.object({
  planId: PlanIdSchema,
  dagId: DagIdSchema,
  parentDagId: v.optional(DagIdSchema),
  parentSnapshotId: v.optional(PlanSnapshotIdSchema),
  specId: SpecIdSchema,
  specVersion: SpecVersionSchema,
  createdAt: IsoTimestampSchema,
  plannerModel: v.string(),
  status: v.picklist(['draft', 'proposed', 'approved', 'executing', 'completed', 'superseded']),
  artifactUri: ArtifactUriSchema,
  approvedSnapshotId: v.optional(PlanSnapshotIdSchema),
  summary: v.string(),
  assumptions: v.array(v.string()),
  milestones: v.array(MilestoneSchema),
  nodes: v.array(TaskNodeSchema),
  edges: v.array(DagEdgeSchema),
  globalAcceptanceCriteria: v.array(v.string()),
  parallelism: ParallelismConfigSchema,
  mergePolicy: MergePolicySchema,
});

export const SnapshotArtifactSchema = v.object({
  uri: ArtifactUriSchema,
  sha256: v.string(),
  kind: v.picklist(['plan-json', 'node-body', 'milestone-body']),
});

export const PlanSnapshotManifestSchema = v.object({
  snapshotId: PlanSnapshotIdSchema,
  planJson: SnapshotArtifactSchema,
  nodeBodies: v.record(NodeIdSchema, SnapshotArtifactSchema),
  milestoneBodies: v.record(MilestoneIdSchema, SnapshotArtifactSchema),
  createdAt: IsoTimestampSchema,
});

export const PlanSnapshotSchema = v.object({
  snapshotId: PlanSnapshotIdSchema,
  planId: PlanIdSchema,
  dagId: DagIdSchema,
  planVersion: v.number(),
  specId: SpecIdSchema,
  specVersion: SpecVersionSchema,
  specSha256: v.string(),
  artifactUri: ArtifactUriSchema,
  manifestUri: ArtifactUriSchema,
  manifestSha256: v.string(),
  createdAt: IsoTimestampSchema,
  approvedBy: v.string(),
  status: v.picklist(['approved', 'executing', 'completed', 'superseded']),
});

export const StateWaitConditionSchema = v.variant('type', [
  v.object({
    type: v.literal('approval'),
    approvalKind: v.picklist(['spec', 'plan', 'gap-dag', 'override']),
  }),
  v.object({
    type: v.literal('dependency'),
    nodeIds: v.array(NodeIdSchema),
  }),
  v.object({
    type: v.literal('timer'),
    delayId: DelayIdSchema,
    durationSeconds: v.number(),
  }),
  v.object({
    type: v.literal('external-event'),
    signalName: v.string(),
  }),
  v.object({
    type: v.literal('child-workflow'),
    workflowId: v.string(),
  }),
]);

export const StateActionSchema = v.variant('type', [
  v.object({
    type: v.literal('activity'),
    activityName: v.string(),
  }),
  v.object({
    type: v.literal('child-workflow'),
    workflowType: v.string(),
  }),
  v.object({
    type: v.literal('transition'),
    to: v.string(),
  }),
  v.object({
    type: v.literal('continue-as-new'),
  }),
  v.object({
    type: v.literal('complete'),
  }),
  v.object({
    type: v.literal('fail'),
  }),
  v.object({
    type: v.literal('needs-human'),
  }),
]);

export const FactoryStateDefinitionSchema = v.object({
  stateId: FactoryStateIdSchema,
  ownerWorkflowType: v.string(),
  kind: v.picklist(['spec', 'plan', 'dag', 'node', 'gate', 'merge', 'milestone', 'gap', 'final']),
  waitsFor: v.array(StateWaitConditionSchema),
  executes: v.array(StateActionSchema),
  legalNextStates: v.array(v.string()),
  retryPolicy: v.picklist(['none', 'activity', 'state', 'human']),
  resetPolicy: v.picklist(['forbidden', 'operator-only', 'allowed']),
});

export const StateTransitionEventSchema = v.object({
  eventId: v.string(),
  stateExecutionId: StateExecutionIdSchema,
  fromStateId: FactoryStateIdSchema,
  toStateId: v.union([FactoryStateIdSchema, v.picklist(['complete', 'fail', 'needs-human'])]),
  reason: v.string(),
  at: IsoTimestampSchema,
  actor: v.picklist(['workflow', 'activity', 'human', 'system']),
  artifactUris: v.array(ArtifactUriSchema),
});

export const FactoryStateExecutionSchema = v.object({
  stateExecutionId: StateExecutionIdSchema,
  stateId: FactoryStateIdSchema,
  ownerWorkflowId: v.string(),
  ownerWorkflowType: v.string(),
  status: v.picklist(['waiting', 'executing', 'completed', 'failed', 'skipped', 'needs_human']),
  startedAt: IsoTimestampSchema,
  completedAt: v.optional(IsoTimestampSchema),
  waitsFor: v.array(StateWaitConditionSchema),
  lastTransition: v.optional(StateTransitionEventSchema),
  artifactUris: v.array(ArtifactUriSchema),
});

export const StateRetryRequestSchema = v.object({
  stateExecutionId: StateExecutionIdSchema,
  requestedBy: v.string(),
  reason: v.string(),
  instructions: v.optional(v.string()),
  expectedStateVersion: v.optional(v.string()),
});

export const StateRetryResultSchema = v.object({
  accepted: v.boolean(),
  newStateExecutionId: v.optional(StateExecutionIdSchema),
  rejectedReason: v.optional(v.string()),
});

export const SkipDelayRequestSchema = v.object({
  delayId: DelayIdSchema,
  requestedBy: v.string(),
  reason: v.string(),
  operatorMode: v.picklist(['test', 'production']),
  expectedStateVersion: v.optional(v.string()),
});

export const SkipDelayResultSchema = v.object({
  accepted: v.boolean(),
  affectedStateExecutionId: v.optional(StateExecutionIdSchema),
  rejectedReason: v.optional(v.string()),
});

export const CommandResultSchema = v.object({
  command: v.string(),
  cwd: v.string(),
  exitCode: v.number(),
  stdoutUri: v.optional(ArtifactUriSchema),
  stderrUri: v.optional(ArtifactUriSchema),
  durationMs: v.number(),
});

export const VerificationResultSchema = v.object({
  command: v.string(),
  status: v.picklist(['passed', 'failed', 'skipped']),
  summary: v.string(),
  artifactUri: v.optional(ArtifactUriSchema),
});

export const GateFailureScopeSchema = v.picklist([
  'node_local',
  'dependency_gap',
  'plan_gap',
  'spec_gap',
  'ambiguous',
]);

export const GateFailureClassificationSchema = v.object({
  scope: GateFailureScopeSchema,
  explanation: v.string(),
  recommendedAction: v.picklist([
    'repair_node',
    'create_followup_dag',
    'request_spec_change',
    'needs_human',
  ]),
});

export const RepairInstructionSchema = v.object({
  repairInstructionId: v.string(),
  nodeId: NodeIdSchema,
  source: v.picklist(['verification', 'review', 'judge', 'diff-scope', 'human']),
  scope: GateFailureScopeSchema,
  summary: v.string(),
  requiredFixes: v.array(v.string()),
  implicatedFiles: v.array(v.string()),
  testsToRun: v.array(v.string()),
  forbiddenChanges: v.array(v.string()),
  sourceReportIds: v.array(v.string()),
  createdAt: IsoTimestampSchema,
});

export const NodeAttemptResultSchema = v.object({
  attemptId: AttemptIdSchema,
  nodeId: NodeIdSchema,
  planSnapshotId: PlanSnapshotIdSchema,
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  status: v.picklist(['completed', 'failed', 'cancelled']),
  summary: v.string(),
  changedFiles: v.array(v.string()),
  commandsRun: v.array(CommandResultSchema),
  testResults: v.array(VerificationResultSchema),
  diffUri: ArtifactUriSchema,
  checkpointCommits: v.array(v.string()),
  commitSha: v.optional(v.string()),
  agentSessionUri: ArtifactUriSchema,
  knownLimitations: v.array(v.string()),
  needsFollowup: v.boolean(),
});

export const NodeRunHistorySchema = v.object({
  nodeId: NodeIdSchema,
  planSnapshotId: PlanSnapshotIdSchema,
  attemptIds: v.array(AttemptIdSchema),
  reviewReportIds: v.array(v.string()),
  judgeReportIds: v.array(v.string()),
  repairInstructions: v.array(RepairInstructionSchema),
  finalGatedCommitSha: v.optional(v.string()),
});

export const ReviewFindingSchema = v.object({
  id: v.string(),
  severity: SeveritySchema,
  category: v.picklist([
    'bug',
    'test-gap',
    'regression',
    'security',
    'performance',
    'maintainability',
    'race',
    'data-loss',
  ]),
  title: v.string(),
  description: v.string(),
  file: v.optional(v.string()),
  line: v.optional(v.number()),
  blocking: v.boolean(),
});

export const ReviewReportSchema = v.object({
  reportId: v.string(),
  nodeId: v.optional(NodeIdSchema),
  milestoneId: v.optional(MilestoneIdSchema),
  reviewerRole: v.picklist(['reviewer', 'broad_reviewer']),
  status: v.picklist(['pass', 'fail', 'needs_human']),
  summary: v.string(),
  findings: v.array(ReviewFindingSchema),
  failureClassification: v.optional(GateFailureClassificationSchema),
  requiredFixes: v.array(v.string()),
  recommendedFixes: v.array(v.string()),
  evidenceUris: v.array(ArtifactUriSchema),
});

export const RequirementJudgementSchema = v.object({
  requirementId: v.string(),
  status: v.picklist(['satisfied', 'partially_satisfied', 'not_satisfied', 'not_applicable']),
  explanation: v.string(),
  evidence: v.array(v.string()),
});

export const CutCornerFindingSchema = v.object({
  id: v.string(),
  severity: SeveritySchema,
  description: v.string(),
  expectedApproach: v.string(),
  observedApproach: v.string(),
  blocking: v.boolean(),
});

export const JudgeReportSchema = v.object({
  reportId: v.string(),
  nodeId: v.optional(NodeIdSchema),
  milestoneId: v.optional(MilestoneIdSchema),
  judgeRole: v.picklist(['judge', 'broad_judge']),
  status: v.picklist(['pass', 'fail', 'needs_human']),
  summary: v.string(),
  requirementResults: v.array(RequirementJudgementSchema),
  cutCornerFindings: v.array(CutCornerFindingSchema),
  failureClassification: v.optional(GateFailureClassificationSchema),
  requiredFixes: v.array(v.string()),
  evidenceUris: v.array(ArtifactUriSchema),
});

export const NodeExecutionStateSchema = v.object({
  nodeId: NodeIdSchema,
  planSnapshotId: PlanSnapshotIdSchema,
  status: v.picklist([
    'blocked',
    'ready',
    'running',
    'awaiting_review',
    'awaiting_judgement',
    'repairing',
    'ready_to_merge',
    'queued_for_merge',
    'merging',
    'merged',
    'failed',
    'skipped',
    'needs_human',
  ]),
  dependencyIds: v.array(NodeIdSchema),
  attemptIds: v.array(AttemptIdSchema),
  activeAttemptId: v.optional(AttemptIdSchema),
  worktreePath: v.optional(v.string()),
  branchName: v.optional(v.string()),
  latestDiffUri: v.optional(ArtifactUriSchema),
  checkpointCommits: v.array(v.string()),
  latestReview: v.optional(ReviewReportSchema),
  latestJudgement: v.optional(JudgeReportSchema),
  mergeRequestId: v.optional(v.string()),
  mergedCommitSha: v.optional(v.string()),
  failureReason: v.optional(v.string()),
});

export const ApprovalCommentSchema = v.object({
  targetId: v.optional(v.string()),
  severity: v.picklist(['info', 'blocking']),
  text: v.string(),
});

export const ApprovalDecisionBaseSchema = v.object({
  decisionId: v.string(),
  actor: v.string(),
  decidedAt: IsoTimestampSchema,
  action: v.picklist(['approve', 'reject', 'request_changes']),
  workflowId: v.string(),
  workflowRunId: v.optional(v.string()),
  targetArtifactUri: ArtifactUriSchema,
  targetArtifactSha256: v.string(),
  payloadVersion: v.string(),
  comments: v.string(),
  structuredComments: v.optional(v.array(ApprovalCommentSchema)),
});

export const SpecApprovalDecisionSchema = v.object({
  decisionId: v.string(),
  actor: v.string(),
  decidedAt: IsoTimestampSchema,
  action: v.picklist(['approve', 'reject', 'request_changes']),
  workflowId: v.string(),
  workflowRunId: v.optional(v.string()),
  targetArtifactUri: ArtifactUriSchema,
  targetArtifactSha256: v.string(),
  payloadVersion: v.string(),
  payload: v.optional(SpecDocumentSchema),
  comments: v.string(),
  structuredComments: v.optional(v.array(ApprovalCommentSchema)),
});

export const PlanApprovalDecisionSchema = v.object({
  decisionId: v.string(),
  actor: v.string(),
  decidedAt: IsoTimestampSchema,
  action: v.picklist(['approve', 'reject', 'request_changes']),
  workflowId: v.string(),
  workflowRunId: v.optional(v.string()),
  targetArtifactUri: ArtifactUriSchema,
  targetArtifactSha256: v.string(),
  payloadVersion: v.string(),
  payload: v.optional(PlanDAGSchema),
  comments: v.string(),
  structuredComments: v.optional(v.array(ApprovalCommentSchema)),
});

export const GapFindingSchema = v.object({
  id: v.string(),
  severity: SeveritySchema,
  category: v.picklist([
    'missing-requirement',
    'integration-bug',
    'design-gap',
    'test-gap',
    'quality-gap',
  ]),
  description: v.string(),
  affectedRequirements: v.array(v.string()),
  suggestedTasks: v.array(v.string()),
  blocking: v.boolean(),
});

export const GapReportSchema = v.object({
  gapReportId: v.string(),
  source: v.picklist([
    'milestone_review',
    'milestone_judge',
    'final_review',
    'final_judge',
    'human_intervention',
  ]),
  milestoneId: v.optional(MilestoneIdSchema),
  summary: v.string(),
  gaps: v.array(GapFindingSchema),
  recommendedPlan: v.picklist(['repair_dag', 'manual_review', 'accept_with_risk']),
});

export const HumanGapRequestSchema = v.object({
  requestId: v.string(),
  actor: v.string(),
  reason: v.string(),
  gapReport: GapReportSchema,
  pauseScheduling: v.boolean(),
  cancelNodeIds: v.optional(v.array(NodeIdSchema)),
  markUnstartedNodeIdsSkipped: v.optional(v.array(NodeIdSchema)),
  requiresApprovalOverride: v.optional(v.boolean()),
});

export const HumanGapResultSchema = v.object({
  accepted: v.boolean(),
  runPaused: v.boolean(),
  cancelledNodeIds: v.array(NodeIdSchema),
  gapReportId: v.optional(v.string()),
  followupDagId: v.optional(DagIdSchema),
  pendingApproval: v.optional(v.boolean()),
  rejectedReason: v.optional(v.string()),
});

export type RunId = v.InferOutput<typeof RunIdSchema>;
export type SpecId = v.InferOutput<typeof SpecIdSchema>;
export type SpecVersion = v.InferOutput<typeof SpecVersionSchema>;
export type PlanId = v.InferOutput<typeof PlanIdSchema>;
export type DagId = v.InferOutput<typeof DagIdSchema>;
export type NodeId = v.InferOutput<typeof NodeIdSchema>;
export type MilestoneId = v.InferOutput<typeof MilestoneIdSchema>;
export type AttemptId = v.InferOutput<typeof AttemptIdSchema>;
export type ArtifactUri = v.InferOutput<typeof ArtifactUriSchema>;
export type RepoId = v.InferOutput<typeof RepoIdSchema>;
export type PlanSnapshotId = v.InferOutput<typeof PlanSnapshotIdSchema>;
export type FactoryStateId = v.InferOutput<typeof FactoryStateIdSchema>;
export type StateExecutionId = v.InferOutput<typeof StateExecutionIdSchema>;
export type DelayId = v.InferOutput<typeof DelayIdSchema>;
export type ArtifactRef = v.InferOutput<typeof ArtifactRefSchema>;
export type Requirement = v.InferOutput<typeof RequirementSchema>;
export type Constraint = v.InferOutput<typeof ConstraintSchema>;
export type AcceptanceCriterion = v.InferOutput<typeof AcceptanceCriterionSchema>;
export type Risk = v.InferOutput<typeof RiskSchema>;
export type OpenQuestion = v.InferOutput<typeof OpenQuestionSchema>;
export type RepoTarget = v.InferOutput<typeof RepoTargetSchema>;
export type SpecDocument = v.InferOutput<typeof SpecDocumentSchema>;
export type WorktreePolicy = v.InferOutput<typeof WorktreePolicySchema>;
export type MergePolicy = v.InferOutput<typeof MergePolicySchema>;
export type MilestoneReviewPolicy = v.InferOutput<typeof MilestoneReviewPolicySchema>;
export type ParallelismConfig = v.InferOutput<typeof ParallelismConfigSchema>;
export type Milestone = v.InferOutput<typeof MilestoneSchema>;
export type TaskNode = v.InferOutput<typeof TaskNodeSchema>;
export type DagEdge = v.InferOutput<typeof DagEdgeSchema>;
export type PlanDAG = v.InferOutput<typeof PlanDAGSchema>;
export type SnapshotArtifact = v.InferOutput<typeof SnapshotArtifactSchema>;
export type PlanSnapshotManifest = v.InferOutput<typeof PlanSnapshotManifestSchema>;
export type PlanSnapshot = v.InferOutput<typeof PlanSnapshotSchema>;
export type StateWaitCondition = v.InferOutput<typeof StateWaitConditionSchema>;
export type StateAction = v.InferOutput<typeof StateActionSchema>;
export type FactoryStateDefinition = v.InferOutput<typeof FactoryStateDefinitionSchema>;
export type StateTransitionEvent = v.InferOutput<typeof StateTransitionEventSchema>;
export type FactoryStateExecution = v.InferOutput<typeof FactoryStateExecutionSchema>;
export type StateRetryRequest = v.InferOutput<typeof StateRetryRequestSchema>;
export type StateRetryResult = v.InferOutput<typeof StateRetryResultSchema>;
export type SkipDelayRequest = v.InferOutput<typeof SkipDelayRequestSchema>;
export type SkipDelayResult = v.InferOutput<typeof SkipDelayResultSchema>;
export type CommandResult = v.InferOutput<typeof CommandResultSchema>;
export type VerificationResult = v.InferOutput<typeof VerificationResultSchema>;
export type GateFailureScope = v.InferOutput<typeof GateFailureScopeSchema>;
export type GateFailureClassification = v.InferOutput<typeof GateFailureClassificationSchema>;
export type RepairInstruction = v.InferOutput<typeof RepairInstructionSchema>;
export type NodeAttemptResult = v.InferOutput<typeof NodeAttemptResultSchema>;
export type NodeRunHistory = v.InferOutput<typeof NodeRunHistorySchema>;
export type ReviewFinding = v.InferOutput<typeof ReviewFindingSchema>;
export type ReviewReport = v.InferOutput<typeof ReviewReportSchema>;
export type RequirementJudgement = v.InferOutput<typeof RequirementJudgementSchema>;
export type CutCornerFinding = v.InferOutput<typeof CutCornerFindingSchema>;
export type JudgeReport = v.InferOutput<typeof JudgeReportSchema>;
export type NodeExecutionState = v.InferOutput<typeof NodeExecutionStateSchema>;
export type ApprovalComment = v.InferOutput<typeof ApprovalCommentSchema>;
export type ApprovalDecisionBase = v.InferOutput<typeof ApprovalDecisionBaseSchema>;
export type SpecApprovalDecision = v.InferOutput<typeof SpecApprovalDecisionSchema>;
export type PlanApprovalDecision = v.InferOutput<typeof PlanApprovalDecisionSchema>;
export type GapFinding = v.InferOutput<typeof GapFindingSchema>;
export type GapReport = v.InferOutput<typeof GapReportSchema>;
export type HumanGapRequest = v.InferOutput<typeof HumanGapRequestSchema>;
export type HumanGapResult = v.InferOutput<typeof HumanGapResultSchema>;

export interface ApprovalDecision<TPayload> extends ApprovalDecisionBase {
  payload?: TPayload;
}
