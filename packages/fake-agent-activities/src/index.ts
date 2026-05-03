import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createLocalArtifactStore,
  type PlanBundleResult,
  type SnapshotManifestResult,
} from '@durafoundry/artifact-store';
import type {
  CommandResult,
  GapReport,
  JudgeReport,
  NodeAttemptResult,
  NodeId,
  PlanDAG,
  PlanSnapshotId,
  RepairInstruction,
  ReviewReport,
} from '@durafoundry/domain';
import { validatePlanDAG, validatePlanSnapshotManifest } from '@durafoundry/domain';

const producer = '@durafoundry/fake-agent-activities';
const defaultNow = (): string => new Date().toISOString();

export interface FakePlannerInput {
  artifactRoot: string;
  planId?: string;
  dagId?: string;
  snapshotId?: PlanSnapshotId;
  specId: string;
  specVersion: string;
  repoId: string;
  repoPath: string;
  trunkBranch: string;
  createdAt?: string;
}

export interface FakePlannerResult {
  bundle: PlanBundleResult;
  snapshot: SnapshotManifestResult;
}

export interface FakeCoderInput {
  repoPath: string;
  nodeId: NodeId;
  attemptId: string;
  planSnapshotId: PlanSnapshotId;
  artifactRoot: string;
  repairInstructions?: RepairInstruction[];
  startedAt?: string;
  completedAt?: string;
}

export interface FakeGateInput {
  nodeId: NodeId;
  attemptNumber: number;
  failFirstAttempt?: boolean;
  createdAt?: string;
}

export interface FakeReviewResult {
  report: ReviewReport;
  repairInstructions: RepairInstruction[];
}

export interface FakeJudgeResult {
  report: JudgeReport;
  repairInstructions: RepairInstruction[];
}

export interface FakeBroadGateInput {
  milestoneId?: string;
  emitGap?: boolean;
}

export interface FakeBroadReviewResult {
  report: ReviewReport;
  gapReport?: GapReport;
}

export interface FakeBroadJudgeResult {
  report: JudgeReport;
  gapReport?: GapReport;
}

export interface FakeGapPlannerInput {
  artifactRoot: string;
  gapReport: GapReport;
  parentPlan: PlanDAG;
  planId?: string;
  dagId?: string;
  snapshotId?: PlanSnapshotId;
  createdAt?: string;
}

export interface FakeGapPlannerResult {
  bundle: PlanBundleResult;
  snapshot: SnapshotManifestResult;
}

export async function runFakePlanner(input: FakePlannerInput): Promise<FakePlannerResult> {
  const createdAt = input.createdAt ?? defaultNow();
  const plan = fixturePlan({
    planId: input.planId ?? 'fixture-plan',
    dagId: input.dagId ?? 'fixture-dag',
    specId: input.specId,
    specVersion: input.specVersion,
    repoId: input.repoId,
    repoPath: input.repoPath,
    trunkBranch: input.trunkBranch,
    createdAt,
  });

  const store = createLocalArtifactStore({ rootDir: input.artifactRoot, now: () => createdAt });
  const bundle = await store.writePlanBundle({
    plan,
    nodeBodies: {
      'fixture-alpha': nodeBody('fixture-alpha', 'src/alpha.txt'),
      'fixture-beta': nodeBody('fixture-beta', 'src/beta.txt'),
    },
    milestoneBodies: {
      'fixture-milestone': '# Fixture milestone\n\nComplete alpha and beta fixture edits.\n',
    },
    producer,
    createdAt,
  });
  const snapshot = await store.writeSnapshotManifest({
    snapshotId: input.snapshotId ?? 'fixture-snapshot',
    planId: bundle.plan.planId,
    planRef: bundle.planRef,
    nodeBodyRefs: bundle.nodeBodyRefs,
    milestoneBodyRefs: bundle.milestoneBodyRefs,
    producer,
    createdAt,
  });

  assertValidPlanAndSnapshot(bundle.plan, snapshot.manifest);
  return { bundle, snapshot };
}

export async function runFakeCoder(input: FakeCoderInput): Promise<NodeAttemptResult> {
  const startedAt = input.startedAt ?? defaultNow();
  const completedAt = input.completedAt ?? startedAt;
  const targetFile = fileForNode(input.repoPath, input.nodeId);
  const repaired = (input.repairInstructions ?? []).length > 0;
  const content = `${input.nodeId}: ${repaired ? 'repaired' : 'implemented'}\n`;

  await writeFile(targetFile, content);

  const store = createLocalArtifactStore({ rootDir: input.artifactRoot, now: () => completedAt });
  const diffRef = await store.writeArtifact({
    kind: 'fake-diff',
    producer,
    content: `diff -- fake ${input.nodeId}\n${await readFile(targetFile, 'utf8')}`,
    relativePath: join('fake-agent', safePathSegment(input.attemptId), 'diff.patch'),
    createdAt: completedAt,
  });
  const sessionRef = await store.writeArtifact({
    kind: 'fake-agent-session',
    producer,
    content: {
      role: 'coder',
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      repaired,
    },
    relativePath: join('fake-agent', safePathSegment(input.attemptId), 'session.json'),
    createdAt: completedAt,
  });

  return {
    attemptId: input.attemptId,
    nodeId: input.nodeId,
    planSnapshotId: input.planSnapshotId,
    startedAt,
    completedAt,
    status: 'completed',
    summary: `Fake coder ${repaired ? 'repaired' : 'implemented'} ${input.nodeId}.`,
    changedFiles: [relativeFixtureFile(input.nodeId)],
    commandsRun: [fakeCommandResult('fake-coder-edit', input.repoPath)],
    testResults: [
      {
        command: 'fake fixture verification',
        status: 'passed',
        summary: `${relativeFixtureFile(input.nodeId)} was updated.`,
      },
    ],
    diffUri: diffRef.uri,
    checkpointCommits: [],
    agentSessionUri: sessionRef.uri,
    knownLimitations: [],
    needsFollowup: false,
  };
}

export function runFakeReviewer(input: FakeGateInput): FakeReviewResult {
  const shouldFail = Boolean(input.failFirstAttempt && input.attemptNumber === 1);
  const reportId = `review-${safePathSegment(input.nodeId)}-${input.attemptNumber}`;
  const report: ReviewReport = shouldFail
    ? {
        reportId,
        nodeId: input.nodeId,
        reviewerRole: 'reviewer',
        status: 'fail',
        summary: `Fake reviewer found a node-local issue in ${input.nodeId}.`,
        findings: [
          {
            id: `${reportId}-finding`,
            severity: 'medium',
            category: 'bug',
            title: 'Fixture edit needs repair',
            description: 'The first fake attempt intentionally fails to exercise repair flow.',
            file: relativeFixtureFile(input.nodeId),
            blocking: true,
          },
        ],
        failureClassification: {
          scope: 'node_local',
          explanation: 'The issue is local to the node output.',
          recommendedAction: 'repair_node',
        },
        requiredFixes: ['Repair the fixture edit for this node.'],
        recommendedFixes: [],
        evidenceUris: [],
      }
    : passReviewReport(reportId, input.nodeId);

  return {
    report,
    repairInstructions: shouldFail
      ? [repairInstruction(input.nodeId, 'review', reportId, input.createdAt)]
      : [],
  };
}

export function runFakeJudge(input: FakeGateInput): FakeJudgeResult {
  const shouldFail = Boolean(input.failFirstAttempt && input.attemptNumber === 1);
  const reportId = `judge-${safePathSegment(input.nodeId)}-${input.attemptNumber}`;
  const report: JudgeReport = shouldFail
    ? {
        reportId,
        nodeId: input.nodeId,
        judgeRole: 'judge',
        status: 'fail',
        summary: `Fake judge found incomplete acceptance for ${input.nodeId}.`,
        requirementResults: [
          {
            requirementId: 'REQ-fixture-edit',
            status: 'partially_satisfied',
            explanation: 'The first fake attempt intentionally fails the acceptance check.',
            evidence: [relativeFixtureFile(input.nodeId)],
          },
        ],
        cutCornerFindings: [
          {
            id: `${reportId}-cut-corner`,
            severity: 'medium',
            description: 'Fixture edit was not accepted on the first pass.',
            expectedApproach: 'Repair the same node before merge.',
            observedApproach: 'Initial fake output requires repair.',
            blocking: true,
          },
        ],
        failureClassification: {
          scope: 'node_local',
          explanation: 'The acceptance gap belongs to this node.',
          recommendedAction: 'repair_node',
        },
        requiredFixes: ['Repair node output and rerun judgement.'],
        evidenceUris: [],
      }
    : passJudgeReport(reportId, input.nodeId);

  return {
    report,
    repairInstructions: shouldFail ? [repairInstruction(input.nodeId, 'judge', reportId, input.createdAt)] : [],
  };
}

export function runFakeBroadReviewer(input: FakeBroadGateInput): FakeBroadReviewResult {
  const reportId = `broad-review-${safePathSegment(input.milestoneId ?? 'final')}`;
  if (!input.emitGap) {
    return {
      report: {
        reportId,
        milestoneId: input.milestoneId,
        reviewerRole: 'broad_reviewer',
        status: 'pass',
        summary: 'Fake broad reviewer accepted integrated work.',
        findings: [],
        requiredFixes: [],
        recommendedFixes: [],
        evidenceUris: [],
      },
    };
  }

  const gapReport = fixtureGapReport('milestone_review', input.milestoneId);
  return {
    report: {
      reportId,
      milestoneId: input.milestoneId,
      reviewerRole: 'broad_reviewer',
      status: 'fail',
      summary: 'Fake broad reviewer found follow-up graph work.',
      findings: [],
      failureClassification: {
        scope: 'plan_gap',
        explanation: 'The gap is outside a single active node and belongs in follow-up graph work.',
        recommendedAction: 'create_followup_dag',
      },
      requiredFixes: gapReport.gaps.flatMap((gap) => gap.suggestedTasks),
      recommendedFixes: [],
      evidenceUris: [],
    },
    gapReport,
  };
}

export function runFakeBroadJudge(input: FakeBroadGateInput): FakeBroadJudgeResult {
  const reportId = `broad-judge-${safePathSegment(input.milestoneId ?? 'final')}`;
  if (!input.emitGap) {
    return {
      report: {
        reportId,
        milestoneId: input.milestoneId,
        judgeRole: 'broad_judge',
        status: 'pass',
        summary: 'Fake broad judge accepted integrated work.',
        requirementResults: [],
        cutCornerFindings: [],
        requiredFixes: [],
        evidenceUris: [],
      },
    };
  }

  const gapReport = fixtureGapReport('milestone_judge', input.milestoneId);
  return {
    report: {
      reportId,
      milestoneId: input.milestoneId,
      judgeRole: 'broad_judge',
      status: 'fail',
      summary: 'Fake broad judge found follow-up graph work.',
      requirementResults: [],
      cutCornerFindings: [],
      failureClassification: {
        scope: 'plan_gap',
        explanation: 'The judged gap is outside a single active node.',
        recommendedAction: 'create_followup_dag',
      },
      requiredFixes: gapReport.gaps.flatMap((gap) => gap.suggestedTasks),
      evidenceUris: [],
    },
    gapReport,
  };
}

export async function runFakeGapPlanner(input: FakeGapPlannerInput): Promise<FakeGapPlannerResult> {
  const createdAt = input.createdAt ?? defaultNow();
  const planId = input.planId ?? `${input.parentPlan.planId}-followup`;
  const dagId = input.dagId ?? `${input.parentPlan.dagId}-followup`;
  const nodes = input.gapReport.gaps.map((gap, index) =>
    fixtureNode({
      id: `followup-${safePathSegment(gap.id)}`,
      milestoneId: 'followup-milestone',
      title: `Follow up ${gap.id}`,
      expectedFile: `src/followup-${index + 1}.txt`,
      riskLevel: gap.severity === 'critical' ? 'critical' : gap.severity === 'high' ? 'high' : 'medium',
    }),
  );
  const plan: PlanDAG = {
    ...input.parentPlan,
    planId,
    dagId,
    parentDagId: input.parentPlan.dagId,
    parentSnapshotId: input.parentPlan.approvedSnapshotId,
    createdAt,
    status: 'proposed',
    artifactUri: 'pending',
    approvedSnapshotId: undefined,
    summary: `Follow-up DAG for ${input.gapReport.gapReportId}`,
    assumptions: ['Generated from structured broad gate gap findings.'],
    milestones: [
      {
        id: 'followup-milestone',
        title: 'Follow-up milestone',
        description: input.gapReport.summary,
        nodeIds: nodes.map((node) => node.id),
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['All blocking gap findings are addressed.'],
      },
    ],
    nodes,
    edges: [],
    globalAcceptanceCriteria: ['Follow-up gap work is complete.'],
  };

  const store = createLocalArtifactStore({ rootDir: input.artifactRoot, now: () => createdAt });
  const nodeBodies = Object.fromEntries(
    nodes.map((node, index) => [
      node.id,
      `# ${node.title}\n\n${input.gapReport.gaps[index]?.description ?? input.gapReport.summary}\n`,
    ]),
  );
  const bundle = await store.writePlanBundle({
    plan,
    nodeBodies,
    milestoneBodies: {
      'followup-milestone': `# Follow-up milestone\n\n${input.gapReport.summary}\n`,
    },
    producer,
    createdAt,
  });
  const snapshot = await store.writeSnapshotManifest({
    snapshotId: input.snapshotId ?? `${planId}-snapshot`,
    planId: bundle.plan.planId,
    planRef: bundle.planRef,
    nodeBodyRefs: bundle.nodeBodyRefs,
    milestoneBodyRefs: bundle.milestoneBodyRefs,
    producer,
    createdAt,
  });

  assertValidPlanAndSnapshot(bundle.plan, snapshot.manifest);
  return { bundle, snapshot };
}

function fixturePlan(input: {
  planId: string;
  dagId: string;
  specId: string;
  specVersion: string;
  repoId: string;
  repoPath: string;
  trunkBranch: string;
  createdAt: string;
}): PlanDAG {
  return {
    planId: input.planId,
    dagId: input.dagId,
    specId: input.specId,
    specVersion: input.specVersion,
    createdAt: input.createdAt,
    plannerModel: 'fake-planner',
    status: 'proposed',
    artifactUri: 'pending',
    summary: 'Fixture implementation plan',
    assumptions: ['Fixture repo contains src/alpha.txt and src/beta.txt.'],
    milestones: [
      {
        id: 'fixture-milestone',
        title: 'Fixture milestone',
        description: 'Complete fixture alpha and beta edits.',
        nodeIds: ['fixture-alpha', 'fixture-beta'],
        reviewPolicy: {
          runBroadReview: true,
          runBroadJudge: true,
          autoPlanGaps: true,
          requireApprovalForGapWork: 'high-risk-only',
        },
        acceptanceCriteria: ['Both fixture files are updated and pass fake gates.'],
      },
    ],
    nodes: [
      fixtureNode({
        id: 'fixture-alpha',
        milestoneId: 'fixture-milestone',
        title: 'Implement fixture alpha',
        expectedFile: 'src/alpha.txt',
        riskLevel: 'low',
      }),
      fixtureNode({
        id: 'fixture-beta',
        milestoneId: 'fixture-milestone',
        title: 'Implement fixture beta',
        expectedFile: 'src/beta.txt',
        riskLevel: 'low',
      }),
    ],
    edges: [],
    globalAcceptanceCriteria: ['Fixture plan completes with review and judgement gates.'],
    parallelism: {
      maxActiveNodes: 2,
      maxActiveHighRiskNodes: 1,
      mergeConcurrency: 1,
    },
    mergePolicy: {
      mode: 'direct-to-trunk',
      trunkBranch: input.trunkBranch,
      requireGreenVerification: true,
      rebaseBeforeMerge: true,
      squash: false,
    },
  };
}

function fixtureNode(input: {
  id: string;
  milestoneId: string;
  title: string;
  expectedFile: string;
  riskLevel: PlanDAG['nodes'][number]['riskLevel'];
}): PlanDAG['nodes'][number] {
  return {
    id: input.id,
    milestoneId: input.milestoneId,
    title: input.title,
    kind: 'code',
    bodyUri: 'pending',
    description: `Edit ${input.expectedFile}.`,
    requirements: [`Update ${input.expectedFile}.`],
    specRequirementIds: ['REQ-fixture-edit'],
    acceptanceCriteria: [`${input.expectedFile} contains the fake implementation.`],
    expectedFiles: [input.expectedFile],
    verificationCommands: ['fake fixture verification'],
    reviewerFocus: ['No unrelated fixture files changed.'],
    judgeRubric: ['Expected fixture file was updated without follow-up work.'],
    riskLevel: input.riskLevel,
    worktree: {
      mode: 'per-node',
      baseRef: 'main',
      cleanup: 'after-merge',
    },
    maxAttempts: 2,
  };
}

function passReviewReport(reportId: string, nodeId: NodeId): ReviewReport {
  return {
    reportId,
    nodeId,
    reviewerRole: 'reviewer',
    status: 'pass',
    summary: `Fake reviewer accepted ${nodeId}.`,
    findings: [],
    requiredFixes: [],
    recommendedFixes: [],
    evidenceUris: [],
  };
}

function passJudgeReport(reportId: string, nodeId: NodeId): JudgeReport {
  return {
    reportId,
    nodeId,
    judgeRole: 'judge',
    status: 'pass',
    summary: `Fake judge accepted ${nodeId}.`,
    requirementResults: [
      {
        requirementId: 'REQ-fixture-edit',
        status: 'satisfied',
        explanation: 'The fake fixture edit satisfies the node requirement.',
        evidence: [relativeFixtureFile(nodeId)],
      },
    ],
    cutCornerFindings: [],
    requiredFixes: [],
    evidenceUris: [],
  };
}

function repairInstruction(
  nodeId: NodeId,
  source: RepairInstruction['source'],
  reportId: string,
  createdAt = defaultNow(),
): RepairInstruction {
  return {
    repairInstructionId: `repair-${source}-${safePathSegment(nodeId)}`,
    nodeId,
    source,
    scope: 'node_local',
    summary: `Repair ${nodeId} based on ${source} feedback.`,
    requiredFixes: [`Repair ${relativeFixtureFile(nodeId)}.`],
    implicatedFiles: [relativeFixtureFile(nodeId)],
    testsToRun: ['fake fixture verification'],
    forbiddenChanges: ['Do not change unrelated fixture files.'],
    sourceReportIds: [reportId],
    createdAt,
  };
}

function fixtureGapReport(source: GapReport['source'], milestoneId?: string): GapReport {
  return {
    gapReportId: `gap-${safePathSegment(milestoneId ?? 'final')}`,
    source,
    milestoneId,
    summary: 'Fake broad gate identified follow-up work outside any active node.',
    gaps: [
      {
        id: 'gap-followup-fixture',
        severity: 'high',
        category: 'quality-gap',
        description: 'Add a follow-up fixture change that is outside the current node scope.',
        affectedRequirements: ['REQ-fixture-edit'],
        suggestedTasks: ['Add follow-up fixture coverage.'],
        blocking: true,
      },
    ],
    recommendedPlan: 'repair_dag',
  };
}

function assertValidPlanAndSnapshot(
  plan: PlanDAG,
  manifest: FakePlannerResult['snapshot']['manifest'],
): void {
  const planResult = validatePlanDAG(plan);
  if (!planResult.valid) {
    throw new Error(`Fake plan is invalid: ${planResult.errors.join('; ')}`);
  }

  const snapshotResult = validatePlanSnapshotManifest(plan, manifest);
  if (!snapshotResult.valid) {
    throw new Error(`Fake snapshot manifest is invalid: ${snapshotResult.errors.join('; ')}`);
  }
}

function fileForNode(repoPath: string, nodeId: NodeId): string {
  return join(repoPath, relativeFixtureFile(nodeId));
}

function relativeFixtureFile(nodeId: NodeId): string {
  if (nodeId.includes('beta')) {
    return 'src/beta.txt';
  }
  if (nodeId.includes('followup')) {
    return 'src/followup.txt';
  }
  return 'src/alpha.txt';
}

function nodeBody(nodeId: NodeId, expectedFile: string): string {
  return `# ${nodeId}\n\nUpdate \`${expectedFile}\` and satisfy fake review and judgement gates.\n`;
}

function fakeCommandResult(command: string, cwd: string): CommandResult {
  return {
    command,
    cwd,
    exitCode: 0,
    durationMs: 0,
  };
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`Invalid path segment: ${value}`);
  }

  return safe;
}
