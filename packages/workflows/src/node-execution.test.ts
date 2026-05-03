import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  ExecuteNodeRequest,
  FactoryRunState,
  NodeExecutionActivities,
  NodeExecutionResult,
} from './contracts.js';
import { executeNodeScaffold } from './scaffold.js';
import type {
  JudgeReport,
  NodeAttemptResult,
  NodeId,
  RepairInstruction,
  ReviewReport,
  TaskNode,
} from '@durafoundry/domain';

test('node execution passes first time and emits gated commit history', async () => {
  const calls = createCallLog();
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ calls }),
  );

  assert.equal(result.state.status, 'ready_to_merge');
  assert.equal(result.history.finalGatedCommitSha, 'commit-node-1-attempt-1');
  assert.deepEqual(result.history.attemptIds, ['node-1-attempt-1']);
  assert.deepEqual(result.history.reviewReportIds, ['review-node-1-1']);
  assert.deepEqual(result.history.judgeReportIds, ['judge-node-1-1']);
  assert.equal(result.attempts[0]?.attempt.changedFiles.includes('src/node-1.txt'), true);
  assert.equal(result.attempts[0]?.attempt.commandsRun.some((command) => command.command === 'git commit'), true);
  assert.equal(result.attempts[0]?.attempt.diffUri, 'file:///diff-node-1-attempt-1.patch');
  assert.deepEqual(result.attempts[0]?.attempt.checkpointCommits, ['commit-node-1-attempt-1']);
  assert.equal(state.nodes['node-1']?.status, 'ready_to_merge');
  assert.equal(state.nodeRuns?.['node-1'], result);
  assert.equal(result.appendedGraphWork, false);
  assert.equal(calls.createWorktree, 1);
});

test('node execution repairs reviewer failure on the same node', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ reviewerFailsFirst: true }),
  );

  assert.equal(result.state.status, 'ready_to_merge');
  assert.deepEqual(result.history.attemptIds, ['node-1-attempt-1', 'node-1-attempt-2']);
  assert.deepEqual(result.history.reviewReportIds, ['review-node-1-1', 'review-node-1-2']);
  assert.equal(result.history.repairInstructions[0]?.source, 'review');
  assert.equal(result.history.repairInstructions[0]?.scope, 'node_local');
  assert.deepEqual(result.attempts[1]?.attempt.checkpointCommits, ['commit-node-1-attempt-2']);
  assert.equal(result.history.finalGatedCommitSha, 'commit-node-1-attempt-2');
  assert.equal(result.appendedGraphWork, false);
  assert.equal(state.requestedFollowup, undefined);
});

test('node execution repairs judge failure on the same node', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ judgeFailsFirst: true }),
  );

  assert.equal(result.state.status, 'ready_to_merge');
  assert.deepEqual(result.history.judgeReportIds, ['judge-node-1-1', 'judge-node-1-2']);
  assert.equal(result.history.repairInstructions[0]?.source, 'judge');
  assert.equal(result.history.finalGatedCommitSha, 'commit-node-1-attempt-2');
});

test('node execution repairs verification failure before review and commit', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ verificationFailsFirst: true }),
  );

  assert.equal(result.state.status, 'ready_to_merge');
  assert.deepEqual(result.history.attemptIds, ['node-1-attempt-1', 'node-1-attempt-2']);
  assert.equal(result.attempts[0]?.commit, undefined);
  assert.equal(result.attempts[0]?.review, undefined);
  assert.equal(result.attempts[0]?.judge, undefined);
  assert.equal(result.history.repairInstructions[0]?.source, 'verification');
  assert.equal(result.history.finalGatedCommitSha, 'commit-node-1-attempt-2');
});

test('node execution runs every configured verification command before review', async () => {
  const calls = createCallLog();
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest({ verificationCommands: ['npm test -- unit', 'npm test -- integration'] }),
    mockNodeActivities({ calls }),
  );

  assert.equal(result.state.status, 'ready_to_merge');
  assert.deepEqual(calls.verificationCommands, ['npm test -- unit', 'npm test -- integration']);
  assert.deepEqual(
    result.attempts[0]?.attempt.testResults.map((verification) => verification.command),
    ['npm test -- unit', 'npm test -- integration'],
  );
});

test('node execution escalates max-attempt reviewer failures to needs-human', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest({ maxAttempts: 2 }),
    mockNodeActivities({ reviewerAlwaysFails: true }),
  );

  assert.equal(result.state.status, 'needs_human');
  assert.match(result.state.failureReason ?? '', /exhausted attempts/);
  assert.deepEqual(result.history.attemptIds, ['node-1-attempt-1', 'node-1-attempt-2']);
  assert.equal(result.history.finalGatedCommitSha, undefined);
  assert.equal(result.history.repairInstructions.length, 2);
  assert.equal(state.nodes['node-1']?.status, 'needs_human');
});

test('node execution escalates out-of-scope review findings without graph append', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ reviewerReturnsPlanGap: true }),
  );

  assert.equal(result.state.status, 'needs_human');
  assert.match(result.state.failureReason ?? '', /out-of-scope/);
  assert.equal(result.history.repairInstructions[0]?.scope, 'plan_gap');
  assert.equal(result.appendedGraphWork, false);
  assert.equal(state.requestedFollowup, undefined);
});

test('node execution escalates failed review with no repair instructions', async () => {
  const state = approvedState();
  const result = await executeNodeScaffold(
    state,
    nodeRequest(),
    mockNodeActivities({ reviewerFailsWithoutRepair: true }),
  );

  assert.equal(result.state.status, 'needs_human');
  assert.match(result.state.failureReason ?? '', /out-of-scope/);
  assert.equal(result.history.repairInstructions.length, 0);
  assert.equal(result.appendedGraphWork, false);
});

test('node execution blocks until dependencies are merged', async () => {
  const calls = createCallLog();
  const state = approvedState({
    depStatus: 'ready_to_merge',
  });
  const result = await executeNodeScaffold(
    state,
    nodeRequest({ dependencyIds: ['dep-1'] }),
    mockNodeActivities({ calls }),
  );

  assert.equal(result.state.status, 'blocked');
  assert.match(result.state.failureReason ?? '', /Unsatisfied dependencies/);
  assert.equal(calls.createWorktree, 0);
  assert.equal(state.nodes['node-1']?.status, 'blocked');
});

function approvedState(input: { depStatus?: FactoryRunState['nodes'][NodeId]['status'] } = {}): FactoryRunState {
  const nodes: FactoryRunState['nodes'] = {
    'node-1': {
      nodeId: 'node-1',
      status: 'ready',
    },
  };
  if (input.depStatus) {
    nodes['dep-1'] = {
      nodeId: 'dep-1',
      status: input.depStatus,
    };
  }

  return {
    runId: 'run-1',
    status: 'executing_dag',
    specUri: 'file:///spec.md',
    specSha256: 'spec-sha',
    artifactRoot: '/tmp/artifacts',
    nodes,
    paused: false,
    approvedSnapshot: {
      snapshotId: 'snapshot-1',
      planId: 'plan-1',
      dagId: 'dag-1',
      planArtifactUri: 'file:///plan.json',
      planArtifactSha256: 'plan-sha',
      manifestUri: 'file:///snapshot.json',
      manifestSha256: 'snapshot-sha',
      approvedBy: 'test',
    },
  };
}

function nodeRequest(
  input: {
    dependencyIds?: NodeId[];
    maxAttempts?: number;
    verificationCommands?: string[];
  } = {},
): ExecuteNodeRequest {
  return {
    node: fixtureNode(input.maxAttempts, input.verificationCommands),
    dependencyIds: input.dependencyIds ?? [],
    repoPath: '/tmp/repo',
    trunkBranch: 'main',
    worktreeRoot: '/tmp/worktrees',
    artifactRoot: '/tmp/artifacts',
    gitAuthor: {
      name: 'DuraFoundry',
      email: 'durafoundry@example.invalid',
    },
  };
}

function fixtureNode(
  maxAttempts = 3,
  verificationCommands = ['npm test -- node-1'],
): TaskNode {
  return {
    id: 'node-1',
    milestoneId: 'milestone-1',
    title: 'Node 1',
    kind: 'code',
    bodyUri: 'file:///node-1.md',
    description: 'Update node fixture.',
    requirements: ['Update node fixture.'],
    specRequirementIds: ['REQ-1'],
    acceptanceCriteria: ['Node fixture is updated.'],
    expectedFiles: ['src/node-1.txt'],
    verificationCommands,
    reviewerFocus: ['Review node fixture.'],
    judgeRubric: ['Judge node fixture.'],
    riskLevel: 'low',
    worktree: {
      mode: 'per-node',
      baseRef: 'main',
      cleanup: 'after-merge',
    },
    maxAttempts,
  };
}

function mockNodeActivities(input: {
  calls?: ReturnType<typeof createCallLog>;
  verificationFailsFirst?: boolean;
  reviewerFailsFirst?: boolean;
  reviewerAlwaysFails?: boolean;
  reviewerReturnsPlanGap?: boolean;
  reviewerFailsWithoutRepair?: boolean;
  judgeFailsFirst?: boolean;
} = {}): NodeExecutionActivities {
  const calls = input.calls ?? createCallLog();
  return {
    async createNodeWorktree(request) {
      calls.createWorktree += 1;
      return {
        repoPath: request.repoPath,
        worktreePath: `${request.worktreeRoot}/${request.nodeId}`,
        branchName: `durafoundry/${request.runId}/${request.nodeId}`,
        baseRef: request.baseRef ?? request.trunkBranch,
        baseCommitSha: 'base-sha',
      };
    },
    async runCoder(request) {
      calls.coder += 1;
      return fakeAttempt(request.nodeId, request.attemptId, request.planSnapshotId);
    },
    async runVerification(request) {
      calls.verification += 1;
      calls.verificationCommands.push(request.command);
      const shouldFail = Boolean(input.verificationFailsFirst && request.attemptNumber === 1);
      return {
        result: {
          command: request.command,
          status: shouldFail ? 'failed' : 'passed',
          summary: shouldFail ? 'Verification failed for node-local output.' : 'Verification passed.',
        },
        repairInstructions: shouldFail
          ? [repairInstruction(request.nodeId, 'verification', 'verification-1')]
          : [],
      };
    },
    async commitNodeChanges(request) {
      calls.commit += 1;
      const attemptNumber = calls.commit + (input.verificationFailsFirst ? 1 : 0);
      return {
        worktreePath: request.worktreePath,
        branchName: 'durafoundry/run-1/node-1',
        commitSha: `commit-${request.nodeId}-attempt-${attemptNumber}`,
        changedFiles: [`src/${request.nodeId}.txt`],
        diffUri: `file:///diff-${request.nodeId}-attempt-${attemptNumber}.patch`,
        commandsRun: [
          {
            command: 'git commit',
            cwd: request.worktreePath,
            exitCode: 0,
            durationMs: 0,
          },
        ],
      };
    },
    async runReviewer(request) {
      calls.reviewer += 1;
      const shouldFail = Boolean(
        input.reviewerAlwaysFails ||
          input.reviewerReturnsPlanGap ||
          input.reviewerFailsWithoutRepair ||
          (input.reviewerFailsFirst && request.attemptNumber === 1),
      );
      return {
        report: shouldFail
          ? failReviewReport(request.nodeId, request.attemptNumber, input.reviewerReturnsPlanGap ? 'plan_gap' : 'node_local')
          : passReviewReport(request.nodeId, request.attemptNumber),
        repairInstructions: shouldFail && !input.reviewerFailsWithoutRepair
          ? [
              repairInstruction(
                request.nodeId,
                'review',
                `review-${request.nodeId}-${request.attemptNumber}`,
                input.reviewerReturnsPlanGap ? 'plan_gap' : 'node_local',
              ),
            ]
          : [],
      };
    },
    async runJudge(request) {
      calls.judge += 1;
      const shouldFail = Boolean(input.judgeFailsFirst && request.attemptNumber === 1);
      return {
        report: shouldFail
          ? failJudgeReport(request.nodeId, request.attemptNumber)
          : passJudgeReport(request.nodeId, request.attemptNumber),
        repairInstructions: shouldFail
          ? [repairInstruction(request.nodeId, 'judge', `judge-${request.nodeId}-${request.attemptNumber}`)]
          : [],
      };
    },
  };
}

function createCallLog() {
  return {
    createWorktree: 0,
    coder: 0,
    verification: 0,
    verificationCommands: [] as string[],
    commit: 0,
    reviewer: 0,
    judge: 0,
  };
}

function fakeAttempt(
  nodeId: NodeId,
  attemptId: string,
  planSnapshotId: string,
): NodeAttemptResult {
  return {
    attemptId,
    nodeId,
    planSnapshotId,
    startedAt: '2026-05-03T12:00:00.000Z',
    completedAt: '2026-05-03T12:00:01.000Z',
    status: 'completed',
    summary: `Implemented ${nodeId}.`,
    changedFiles: [`src/${nodeId}.txt`],
    commandsRun: [
      {
        command: 'fake coder',
        cwd: '/tmp/worktrees/node-1',
        exitCode: 0,
        durationMs: 0,
      },
    ],
    testResults: [],
    diffUri: `file:///fake-${attemptId}.patch`,
    checkpointCommits: [],
    agentSessionUri: `file:///session-${attemptId}.json`,
    knownLimitations: [],
    needsFollowup: false,
  };
}

function passReviewReport(nodeId: NodeId, attemptNumber: number): ReviewReport {
  return {
    reportId: `review-${nodeId}-${attemptNumber}`,
    nodeId,
    reviewerRole: 'reviewer',
    status: 'pass',
    summary: 'Review passed.',
    findings: [],
    requiredFixes: [],
    recommendedFixes: [],
    evidenceUris: [],
  };
}

function failReviewReport(
  nodeId: NodeId,
  attemptNumber: number,
  scope: RepairInstruction['scope'],
): ReviewReport {
  return {
    reportId: `review-${nodeId}-${attemptNumber}`,
    nodeId,
    reviewerRole: 'reviewer',
    status: 'fail',
    summary: 'Review failed.',
    findings: [
      {
        id: `finding-${attemptNumber}`,
        severity: 'medium',
        category: 'bug',
        title: 'Repair required',
        description: 'Fake review failure.',
        file: `src/${nodeId}.txt`,
        blocking: true,
      },
    ],
    failureClassification: {
      scope,
      explanation: 'Fake review classification.',
      recommendedAction: scope === 'node_local' ? 'repair_node' : 'create_followup_dag',
    },
    requiredFixes: ['Repair the node.'],
    recommendedFixes: [],
    evidenceUris: [],
  };
}

function passJudgeReport(nodeId: NodeId, attemptNumber: number): JudgeReport {
  return {
    reportId: `judge-${nodeId}-${attemptNumber}`,
    nodeId,
    judgeRole: 'judge',
    status: 'pass',
    summary: 'Judge passed.',
    requirementResults: [
      {
        requirementId: 'REQ-1',
        status: 'satisfied',
        explanation: 'Requirement satisfied.',
        evidence: [`src/${nodeId}.txt`],
      },
    ],
    cutCornerFindings: [],
    requiredFixes: [],
    evidenceUris: [],
  };
}

function failJudgeReport(nodeId: NodeId, attemptNumber: number): JudgeReport {
  return {
    reportId: `judge-${nodeId}-${attemptNumber}`,
    nodeId,
    judgeRole: 'judge',
    status: 'fail',
    summary: 'Judge failed.',
    requirementResults: [
      {
        requirementId: 'REQ-1',
        status: 'partially_satisfied',
        explanation: 'Fake judge failure.',
        evidence: [`src/${nodeId}.txt`],
      },
    ],
    cutCornerFindings: [
      {
        id: `cut-corner-${attemptNumber}`,
        severity: 'medium',
        description: 'Repair required.',
        expectedApproach: 'Complete node acceptance.',
        observedApproach: 'Incomplete fake output.',
        blocking: true,
      },
    ],
    failureClassification: {
      scope: 'node_local',
      explanation: 'Fake judge classification.',
      recommendedAction: 'repair_node',
    },
    requiredFixes: ['Repair acceptance.'],
    evidenceUris: [],
  };
}

function repairInstruction(
  nodeId: NodeId,
  source: RepairInstruction['source'],
  sourceReportId: string,
  scope: RepairInstruction['scope'] = 'node_local',
): RepairInstruction {
  return {
    repairInstructionId: `repair-${source}-${sourceReportId}`,
    nodeId,
    source,
    scope,
    summary: `Repair ${nodeId}.`,
    requiredFixes: [`Repair ${nodeId}.`],
    implicatedFiles: [`src/${nodeId}.txt`],
    testsToRun: ['npm test -- node-1'],
    forbiddenChanges: ['Do not change unrelated files.'],
    sourceReportIds: [sourceReportId],
    createdAt: '2026-05-03T12:00:00.000Z',
  };
}
