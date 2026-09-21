import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountState, ExtractionResult, ObservationCandidate, SystemAnalysisCandidate, SystemAnalysisReview } from '../packages/contracts/src/index.ts';
import { stableHash } from '../packages/health-core/src/index.ts';
import type { CodexRuntimeManager } from '../apps/desktop/src/main/codex-runtime.ts';
import { ProcessingJobRunner } from '../apps/desktop/src/main/job-runner.ts';
import { SystemAnalysisPipeline } from '../apps/desktop/src/main/system-analysis-pipeline.ts';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.ts';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requestedUserData = argument('user-data');
if (!requestedUserData) throw new Error('请提供 --user-data=/private/tmp/family-health-app-smoke-...');
const userData = resolve(requestedUserData);
const expectedParent = resolve(tmpdir());
if (dirname(userData) !== expectedParent || !basename(userData).startsWith('family-health-app-smoke-')) {
  throw new Error(`SMOKE_USER_DATA_OUTSIDE_ALLOWED_ROOT: ${userData}`);
}

mkdirSync(userData, { recursive: true });
const workspaceRoot = join(userData, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(userData, 'desktop-state.json'), `${JSON.stringify({
  activeWorkspaceMode: 'personal',
  workspaceName: '异常恢复合成验收工作区',
  stayInTray: false,
  openAtLogin: false,
  notificationsEnabled: true,
  displayPreferences: { fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' },
  aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' }
}, null, 2)}\n`);

const accountState: AccountState = {
  status: 'connected',
  displayLabel: 'synthetic@example.test',
  quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic-runtime',
  lastCheckedAt: '2026-09-21T11:00:00.000Z'
};
const now = () => new Date('2026-09-21T11:00:00.000Z');
let service = new PersonalWorkspaceService(workspaceRoot, '异常恢复合成验收工作区', now);

async function importReviewDocument(
  displayName: string,
  sourceText: string,
  personId: string,
  candidatesForSpans: (spanIds: string[], quotes: string[]) => ObservationCandidate[],
  reasonCode: string
) {
  const receipt = await service.importFiles([{ path: `/tmp/${displayName}`, bytes: Buffer.from(sourceText) }], personId);
  requireCondition(receipt.importedCount === 1, `SMOKE_IMPORT_FAILED:${displayName}:${JSON.stringify(receipt)}`);
  const document = service.getSnapshot(null).inbox.find((item) => item.displayName === displayName);
  requireCondition(document, `SMOKE_DOCUMENT_NOT_FOUND:${displayName}`);
  const bundle = service.store.getDocumentExtractionBundle(document.id);
  const candidates = candidatesForSpans(bundle.manifest.spans.map((span) => span.id), bundle.manifest.spans.map((span) => span.quote ?? ''));
  const issueId = service.store.saveExtractionReviewIssue({
    documentId: document.id,
    kind: 'field_conflict',
    severity: 'blocking',
    evidenceRefs: bundle.manifest.spans.map((span) => span.id),
    candidateOptions: candidates,
    candidateDiffs: candidates.map((candidate) => ({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] })),
    reasonCodes: [reasonCode],
    documentRun: {
      coverageComplete: true,
      coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
      manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
      chunkCount: 1
    }
  });
  return { documentId: document.id, issueId, candidates };
}

function numericCandidate(input: {
  localKey: string;
  originalName: string;
  standardNameCandidate: string;
  value: string;
  unit: string;
  range: string | null;
  flag: string | null;
  date: string;
  spanId: string;
  quote: string;
}): ObservationCandidate {
  return {
    localKey: input.localKey,
    originalName: input.originalName,
    standardNameCandidate: input.standardNameCandidate,
    value: { kind: 'numeric', rawText: input.value, decimal: input.value, comparator: 'eq' },
    unitRaw: input.unit,
    referenceRangeRaw: input.range,
    reportedAbnormalFlag: input.flag,
    specimen: '血清',
    method: null,
    bodySite: null,
    clinicalDate: input.date,
    evidence: [{ sourceSpanId: input.spanId, quote: input.quote }],
    issues: []
  };
}

async function publishCardiovascularAnalysis(personId: string, modelId: string, headline: string) {
  const bundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular', modelId);
  const evidenceIds = bundle.directFacts.map((fact) => fact.evidence.id);
  const candidate: SystemAnalysisCandidate = {
    schemaVersion: 2,
    personId,
    systemId: 'cardiovascular',
    inputSignature: bundle.scope.inputSignature,
    headline,
    dataQuality: 'partial',
    keyPoints: [{
      id: `exception-summary-${modelId}`,
      kind: 'fact_summary',
      text: headline,
      evidenceIds,
      limitations: ['纯合成验收资料，仅验证增量与恢复机制。'],
      trendFactIds: bundle.trends.map((trend) => trend.id)
    }],
    topicSections: [{
      topicId: 'blood-lipids',
      title: '血脂',
      claimIds: [`exception-summary-${modelId}`],
      seriesIds: bundle.trends.map((trend) => trend.id),
      findingIds: []
    }],
    conflicts: [],
    dataGaps: [],
    discussionPoints: []
  };
  const review: SystemAnalysisReview = {
    schemaVersion: 1,
    personId,
    systemId: 'cardiovascular',
    inputSignature: bundle.scope.inputSignature,
    overallSupported: true,
    itemReviews: [{ itemId: candidate.keyPoints[0]!.id, supported: true, safe: true, trendConsistent: true, issue: null }]
  };
  let turn = 0;
  const result = await new SystemAnalysisPipeline(service.store, {
    runStructuredTurn: async () => ({
      threadId: `synthetic-exception-${modelId}`,
      turnId: `synthetic-exception-${modelId}-${++turn}`,
      output: turn === 1 ? candidate : review
    })
  }, undefined, undefined, undefined, modelId).process(personId, 'cardiovascular');
  requireCondition(result.status === 'published', `SMOKE_ANALYSIS_FAILED:${modelId}:${JSON.stringify(result)}`);
  return result;
}

try {
  requireCondition(service.getSnapshot(null).persons.length === 0, 'SMOKE_WORKSPACE_MUST_BE_EMPTY');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员丁', relation: '本人' });
  const initial = await importReviewDocument(
    '异常恢复基础报告.txt',
    '2026-09-10 LDL-C 4.2 mmol/L ↑，参考范围 0-3.4 mmol/L',
    personId,
    ([spanId], [quote]) => [numericCandidate({
      localKey: 'base-ldl', originalName: 'LDL-C', standardNameCandidate: '低密度脂蛋白胆固醇',
      value: '4.2', unit: 'mmol/L', range: '0-3.4', flag: '↑', date: '2026-09-10', spanId: spanId!, quote: quote!
    })],
    'SYNTHETIC_EXCEPTION_BASE'
  );
  service.acceptCorrectedFacts(initial);
  await publishCardiovascularAnalysis(personId, 'exception-v1', '基础报告已整理为可追溯的心血管说明。');
  const firstSnapshotId = service.getBodySystemDetail(personId, 'cardiovascular').analysis?.id;
  requireCondition(firstSnapshotId, 'SMOKE_INITIAL_ANALYSIS_MISSING');

  const historyNote = service.store.createManualNote({
    personId,
    kind: 'history',
    immutableText: '本人补充：既往曾被提醒关注血脂，尚无更多可核实细节。',
    effectiveDate: null,
    structuredFields: { systemId: 'cardiovascular' },
    expectedContextRevision: service.store.getClinicalContextRevision(personId)
  });
  const updatedBundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'exception-v2');
  requireCondition(updatedBundle.personalContext.some((item) => item.id === historyNote.id), 'SMOKE_HISTORY_NOT_IN_ANALYSIS_CONTEXT');
  await publishCardiovascularAnalysis(personId, 'exception-v2', '新增本人病史补充已纳入心血管说明，原始报告事实保持不变。');
  const secondSnapshot = service.getBodySystemDetail(personId, 'cardiovascular').analysis;
  requireCondition(secondSnapshot, 'SMOKE_REANALYSIS_MISSING');
  requireCondition(secondSnapshot.id !== firstSnapshotId && secondSnapshot.headline.includes('病史补充'), 'SMOKE_REANALYSIS_NOT_PUBLISHED');

  const beforeExclusionCount = service.store.listAcceptedObservations(personId).length;
  service.setDocumentIncluded({ documentId: initial.documentId, included: false, confirmedExclusion: true });
  requireCondition(service.buildSystemEvidenceBundle(personId, 'cardiovascular').directFacts.length === 0, 'SMOKE_EXCLUDED_DOCUMENT_STILL_ANALYZED');
  service.setDocumentIncluded({ documentId: initial.documentId, included: true });
  requireCondition(service.buildSystemEvidenceBundle(personId, 'cardiovascular').directFacts.length === 1, 'SMOKE_REINCLUDED_DOCUMENT_NOT_RESTORED');
  requireCondition(service.store.listAcceptedObservations(personId).length === beforeExclusionCount, 'SMOKE_REINCLUSION_DUPLICATED_FACTS');

  const mixed = await importReviewDocument(
    '多块混合冲突合成报告.txt',
    ['2026-09-11 甘油三酯 1.3 mmol/L', '2026-09-11 HDL-C 1.0 mmol/L ↑', '2026-09-11 收缩压候选 107 或 170 mmHg'].join('\n'),
    personId,
    (spanIds, quotes) => [
      numericCandidate({ localKey: 'mixed-agreed', originalName: '甘油三酯', standardNameCandidate: '甘油三酯', value: '1.3', unit: 'mmol/L', range: null, flag: null, date: '2026-09-11', spanId: spanIds[0]!, quote: quotes[0]! }),
      numericCandidate({ localKey: 'mixed-symbol', originalName: 'HDL-C', standardNameCandidate: '高密度脂蛋白胆固醇', value: '1.0', unit: 'mmol/L', range: null, flag: '↑', date: '2026-09-11', spanId: spanIds[1]!, quote: quotes[1]! }),
      numericCandidate({ localKey: 'mixed-core', originalName: '收缩压候选', standardNameCandidate: '收缩压', value: '107', unit: 'mmHg', range: null, flag: null, date: '2026-09-11', spanId: spanIds[2]!, quote: quotes[2]! })
    ],
    'SYNTHETIC_MIXED_CONFLICT'
  );
  const correctedMixed = mixed.candidates.map((candidate) => candidate.localKey === 'mixed-core'
    ? { ...candidate, value: { kind: 'numeric' as const, rawText: '170', decimal: '170', comparator: 'eq' as const } }
    : candidate);
  service.acceptCorrectedFacts({ issueId: mixed.issueId, documentId: mixed.documentId, candidates: correctedMixed });
  requireCondition(service.store.listAcceptedObservations(personId).some((item) => item.rawText === '170'), 'SMOKE_ITEM_CORRECTION_NOT_PUBLISHED');

  const pending = await importReviewDocument(
    '重启后继续核对合成报告.txt',
    '2026-09-12 血清肌酐 88 umol/L，参考范围 57-97 umol/L',
    personId,
    ([spanId], [quote]) => [numericCandidate({
      localKey: 'pending-creatinine', originalName: '血清肌酐', standardNameCandidate: '血清肌酐',
      value: '88', unit: 'umol/L', range: '57-97', flag: '正常', date: '2026-09-12', spanId: spanId!, quote: quote!
    })],
    'SYNTHETIC_PERSISTED_REVIEW'
  );
  requireCondition(service.store.listOpenExtractionReviewIssues().some((issue) => issue.id === pending.issueId), 'SMOKE_PENDING_REVIEW_NOT_OPEN');

  const cancelReceipt = await service.importFiles([{
    path: '/tmp/迟到结果取消合成报告.txt',
    bytes: Buffer.from('2026-09-13 LDL-C 9.9 mmol/L')
  }], personId);
  requireCondition(cancelReceipt.importedCount === 1, 'SMOKE_CANCEL_DOCUMENT_IMPORT_FAILED');
  const cancelDocument = service.getSnapshot(null).inbox.find((item) => item.displayName === '迟到结果取消合成报告.txt');
  requireCondition(cancelDocument, 'SMOKE_CANCEL_DOCUMENT_NOT_FOUND');
  const cancelBundle = service.store.getDocumentExtractionBundle(cancelDocument.id);
  const cancelSpan = cancelBundle.manifest.spans[0]!;
  const consentId = service.store.createManualProcessingConsent({
    documentIds: [cancelDocument.id],
    personIds: [personId],
    accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel }),
    version: 1
  });
  service.store.createWaitingAuthBatch({
    cutoff: '2026-09-21T11:00:00.000Z',
    initialStatus: 'queued',
    consentId,
    groups: [{ personId, documentIds: [cancelDocument.id], inputSignature: 'synthetic-late-result-job' }]
  });
  let resolveTurn!: (value: { threadId: string; turnId: string; output: ExtractionResult }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const lateExtraction: ExtractionResult = {
    schemaVersion: 1,
    documentId: cancelDocument.id,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: [cancelSpan.id],
    candidates: [numericCandidate({
      localKey: 'late-ldl', originalName: 'LDL-C', standardNameCandidate: '低密度脂蛋白胆固醇',
      value: '9.9', unit: 'mmol/L', range: null, flag: null, date: '2026-09-13', spanId: cancelSpan.id, quote: cancelSpan.quote!
    })],
    reportMetadata: null
  };
  const runtime = {
    getState: () => accountState,
    runStructuredTurn: async () => new Promise<{ threadId: string; turnId: string; output: ExtractionResult }>((resolveTurnPromise) => {
      resolveTurn = resolveTurnPromise;
      markStarted();
    }),
    interruptActiveTurn: async () => undefined
  } as unknown as CodexRuntimeManager;
  const runner = new ProcessingJobRunner(runtime);
  const running = runner.runAvailableJobs(service.store);
  await started;
  const runningJob = service.store.listStoredJobs().find((job) => job.status === 'running');
  requireCondition(runningJob, 'SMOKE_RUNNING_JOB_NOT_FOUND');
  await runner.cancelJob(service.store, runningJob.id);
  resolveTurn({ threadId: 'synthetic-late-thread', turnId: 'synthetic-late-turn', output: lateExtraction });
  await running;
  requireCondition(service.store.listStoredJobs().some((job) => job.id === runningJob.id && job.status === 'cancelled'), 'SMOKE_JOB_NOT_CANCELLED');
  requireCondition(!service.store.listAcceptedObservations(personId).some((item) => item.documentId === cancelDocument.id), 'SMOKE_LATE_RESULT_WAS_PUBLISHED');

  const acceptedBeforeRestart = service.store.listAcceptedObservations(personId).length;
  const openIssueBeforeRestart = service.store.listOpenExtractionReviewIssues().find((issue) => issue.id === pending.issueId);
  requireCondition(openIssueBeforeRestart, 'SMOKE_PENDING_REVIEW_MISSING_BEFORE_RESTART');
  service.close();
  service = new PersonalWorkspaceService(workspaceRoot, '异常恢复合成验收工作区', now);
  requireCondition(service.store.listAcceptedObservations(personId).length === acceptedBeforeRestart, 'SMOKE_ACCEPTED_FACTS_LOST_AFTER_RESTART');
  const reopenedIssue = service.store.listOpenExtractionReviewIssues().find((issue) => issue.id === pending.issueId);
  requireCondition(reopenedIssue, 'SMOKE_PENDING_REVIEW_LOST_AFTER_RESTART');
  service.acceptCorrectedFacts({ issueId: pending.issueId, documentId: pending.documentId, candidates: pending.candidates });
  requireCondition(!service.store.listOpenExtractionReviewIssues().some((issue) => issue.id === pending.issueId), 'SMOKE_PENDING_REVIEW_NOT_COMPLETABLE_AFTER_RESTART');
  requireCondition(service.store.listAcceptedObservations(personId).length === acceptedBeforeRestart + 1, 'SMOKE_RESTART_REVIEW_FACT_NOT_PUBLISHED');

  process.stdout.write(`${JSON.stringify({
    userData,
    personId,
    initialAnalysisId: firstSnapshotId,
    reanalysisId: secondSnapshot.id,
    historyContextIncluded: true,
    exclusion: { removedFromAnalysis: true, restoredWithoutFactDuplication: true },
    mixedConflict: { correctedValue: '170', locallyResolved: true },
    cancelledLateJob: { jobId: runningJob.id, status: 'cancelled', lateResultPublished: false },
    restart: {
      acceptedFactsPreserved: acceptedBeforeRestart,
      pendingReviewPreserved: true,
      pendingReviewCompletedAfterRestart: true,
      finalAcceptedFacts: service.store.listAcceptedObservations(personId).length
    }
  }, null, 2)}\n`);
} finally {
  service.close();
}
