import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SystemAnalysisCandidate, SystemAnalysisReview } from '../packages/contracts/src/index.ts';
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

const service = new PersonalWorkspaceService(resolve(userData, 'workspace'), '合成验收工作区', () => new Date('2027-09-21T08:00:00.000Z'));

try {
  const person = service.getSnapshot(null).persons[0];
  requireCondition(person, 'SMOKE_PERSON_NOT_FOUND');
  const personId = person.id;
  const beforePlan = service.getLifestylePlan(personId);
  requireCondition(beforePlan.adoptedActions.length === 1, `SMOKE_EXPECTED_ONE_ADOPTED_ACTION: ${beforePlan.adoptedActions.length}`);
  requireCondition(beforePlan.proposals.length === 1 && beforePlan.proposals[0]?.status === 'adopted', 'SMOKE_EXPECTED_ONE_ADOPTED_PROPOSAL');
  const beforeAction = beforePlan.adoptedActions[0]!;
  const beforeProposal = beforePlan.proposals[0]!;
  const beforeFactRevision = service.store.getFactRevision(personId);

  const displayName = '合成年度健康报告-2027.txt';
  const sourceText = '2027-09-12 低密度脂蛋白胆固醇 3.9 mmol/L ↑，参考范围 0-3.4 mmol/L';
  const receipt = await service.importFiles([{ path: `/tmp/${displayName}`, bytes: Buffer.from(sourceText) }], personId);
  requireCondition(receipt.importedCount === 1, `SMOKE_NEW_REPORT_IMPORT_FAILED: ${JSON.stringify(receipt)}`);
  const document = service.getSnapshot(null).inbox.find((item) => item.displayName === displayName);
  requireCondition(document, 'SMOKE_NEW_DOCUMENT_NOT_FOUND');
  const documentId = document.id;
  const bundle = service.store.getDocumentExtractionBundle(documentId);
  requireCondition(bundle.manifest.spans.length === 1, `SMOKE_NEW_SOURCE_SPAN_COUNT_MISMATCH: ${bundle.manifest.spans.length}`);
  const span = bundle.manifest.spans[0]!;
  const candidate = {
    localKey: 'ldl-2027',
    originalName: '低密度脂蛋白胆固醇',
    standardNameCandidate: '低密度脂蛋白胆固醇',
    value: { kind: 'numeric' as const, rawText: '3.9', decimal: '3.9', comparator: 'eq' as const },
    unitRaw: 'mmol/L',
    referenceRangeRaw: '0-3.4',
    reportedAbnormalFlag: '↑',
    specimen: '血清',
    method: null,
    bodySite: null,
    clinicalDate: '2027-09-12',
    evidence: [{ sourceSpanId: span.id, quote: span.quote }],
    issues: []
  };
  const issueId = service.store.saveExtractionReviewIssue({
    documentId,
    kind: 'field_conflict',
    severity: 'blocking',
    evidenceRefs: [span.id],
    candidateOptions: [candidate],
    candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
    reasonCodes: ['SYNTHETIC_SMOKE_NEW_REPORT'],
    documentRun: {
      coverageComplete: true,
      coveredSourceSpanIds: [span.id],
      manifestSpanIds: [span.id],
      chunkCount: 1
    }
  });
  service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
  const newReport = service.store.listReportMetadata(personId).find((report) => report.documentId === documentId);
  requireCondition(newReport, 'SMOKE_NEW_REPORT_METADATA_NOT_FOUND');
  service.updateReportMetadata({
    personId,
    reportId: newReport.reportId,
    expectedRevision: newReport.metadataRevision,
    title: '合成年度健康报告（2027）',
    organization: '合成健康中心',
    department: '健康管理科',
    clinicalTime: { value: '2027-09-12', precision: 'day' },
    reason: '合成新增报告验收数据'
  });

  const cardiovascular = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'synthetic-smoke-model-v2');
  const ldlFacts = cardiovascular.directFacts.filter((fact) => fact.name.includes('低密度脂蛋白'));
  requireCondition(ldlFacts.length === 4, `SMOKE_EXPECTED_FOUR_LDL_FACTS: ${ldlFacts.length}`);
  const analysisCandidate: SystemAnalysisCandidate = {
    schemaVersion: 2,
    personId,
    systemId: 'cardiovascular',
    inputSignature: cardiovascular.scope.inputSignature,
    headline: '四次记录显示低密度脂蛋白胆固醇先升高、最近一次略有回落，但仍带有原报告偏高标记。',
    dataQuality: 'partial',
    keyPoints: [{
      id: 'synthetic-ldl-trend-v2',
      kind: 'trend_description',
      text: '低密度脂蛋白胆固醇为 3.1 → 3.6 → 4.2 → 3.9 mmol/L；最近一次较前一次下降 0.3 mmol/L，但仍高于该报告参考上限 3.4 mmol/L。',
      evidenceIds: ldlFacts.map((fact) => fact.evidence.id),
      limitations: ['当前只有四次合成记录，不能替代医生结合完整病史判断。'],
      trendFactIds: cardiovascular.trends.map((trend) => trend.id)
    }],
    topicSections: [{
      topicId: 'blood-lipids',
      title: '血脂',
      claimIds: ['synthetic-ldl-trend-v2'],
      seriesIds: cardiovascular.trends.map((trend) => trend.id),
      findingIds: []
    }],
    conflicts: [],
    dataGaps: [{ text: '缺少更完整的心血管背景资料。', consequence: '目前只呈现报告事实和趋势，不做诊断。' }],
    discussionPoints: []
  };
  const analysisReview: SystemAnalysisReview = {
    schemaVersion: 1,
    personId,
    systemId: 'cardiovascular',
    inputSignature: cardiovascular.scope.inputSignature,
    overallSupported: true,
    itemReviews: [{ itemId: 'synthetic-ldl-trend-v2', supported: true, safe: true, trendConsistent: true, issue: null }]
  };
  let systemTurn = 0;
  const analysisResult = await new SystemAnalysisPipeline(service.store, {
    runStructuredTurn: async () => ({
      threadId: 'synthetic-system-thread-v2',
      turnId: `synthetic-system-v2-${++systemTurn}`,
      output: systemTurn === 1 ? analysisCandidate : analysisReview
    })
  }, undefined, undefined, undefined, 'synthetic-smoke-model-v2').process(personId, 'cardiovascular');
  requireCondition(analysisResult.status === 'published', `SMOKE_UPDATED_SYSTEM_ANALYSIS_FAILED: ${JSON.stringify(analysisResult)}`);

  const observations = service.store.listAcceptedObservations(personId);
  const ldlObservationIds = observations
    .filter((observation) => observation.conceptKey.toLocaleLowerCase().includes('ldl') || observation.conceptKey.includes('低密度'))
    .map((observation) => observation.id);
  requireCondition(ldlObservationIds.length === 4, `SMOKE_EXPECTED_FOUR_LDL_OBSERVATIONS: ${ldlObservationIds.length}`);
  service.store.publishDerivedSnapshot({
    candidate: {
      schemaVersion: 1,
      personId,
      factRevision: service.store.getFactRevision(personId),
      dataQuality: 'partial',
      claims: [{
        id: 'synthetic-action-claim-v2',
        organId: 'cardiovascular',
        level: 'action',
        title: '带着四次血脂结果咨询医生',
        explanation: '最近一次较前一次略有回落，但仍带有原报告偏高标记；可以带着四次结果请医生结合个人情况判断。',
        evidenceObservationIds: ldlObservationIds,
        boundaryNote: '这不是诊断，也不提供用药建议。'
      }],
      lifestyleGuidance: [{
        id: 'synthetic-guidance-walk-v2',
        dedupeKey: 'sustainable-daily-activity',
        category: 'exercise',
        title: '继续可持续的日常活动',
        goal: '保持已经由本人采纳的日常活动方向',
        rationale: '新增报告会更新事实和说明，但不应覆盖或重新询问用户已经作出的行动决定。',
        detail: '继续按照本人已经选择的起始方式行动；新报告只更新健康说明，不重置行动。',
        steps: ['保留原有行动设置', '根据身体感受记录进展'],
        startingOptions: ['沿用已经选择的起始方式'],
        scheduleSuggestion: '沿用本人已经决定的计划时间',
        trackingSuggestion: '继续记录是否完成和身体感受。',
        constraints: ['出现不适时停止并咨询专业人员'],
        uncertainties: ['现有资料不足以给出个体化运动强度'],
        evidenceObservationIds: ldlObservationIds,
        generalKnowledgeEvidence: [],
        sourceKind: 'ai_proposed',
        relatedSystemIds: ['cardiovascular'],
        consultProfessional: true
      }]
    },
    expectedFactRevision: service.store.getFactRevision(personId),
    expectedContextRevision: service.store.getClinicalContextRevision(personId),
    promptVersion: 'synthetic-member-v2-refresh',
    rulesVersion: 'synthetic-safe-v1',
    modelId: 'synthetic-smoke-model-v2'
  });

  const afterPlan = service.getLifestylePlan(personId);
  const afterAction = afterPlan.adoptedActions[0];
  requireCondition(afterPlan.proposals.length === 1, `SMOKE_DUPLICATE_PROPOSAL_AFTER_REFRESH: ${afterPlan.proposals.length}`);
  requireCondition(afterPlan.proposals[0]?.id === beforeProposal.id && afterPlan.proposals[0]?.status === 'adopted', 'SMOKE_ADOPTED_PROPOSAL_NOT_PRESERVED');
  requireCondition(afterPlan.adoptedActions.length === 1 && afterAction, `SMOKE_ADOPTED_ACTION_COUNT_CHANGED: ${afterPlan.adoptedActions.length}`);
  requireCondition(afterAction.id === beforeAction.id && afterAction.proposalId === beforeAction.proposalId, 'SMOKE_ADOPTED_ACTION_ID_CHANGED');
  requireCondition(afterAction.userGoal === beforeAction.userGoal, 'SMOKE_USER_GOAL_OVERWRITTEN');
  requireCondition(afterAction.selectedStartingOption === beforeAction.selectedStartingOption, 'SMOKE_STARTING_OPTION_OVERWRITTEN');
  requireCondition(afterAction.plannedTime === beforeAction.plannedTime, 'SMOKE_PLANNED_TIME_OVERWRITTEN');
  requireCondition(afterAction.owner === beforeAction.owner, 'SMOKE_ACTION_OWNER_OVERWRITTEN');
  requireCondition(afterAction.progressNote === beforeAction.progressNote, 'SMOKE_PROGRESS_NOTE_OVERWRITTEN');
  const systemDetail = service.getBodySystemDetail(personId, 'cardiovascular');
  const ldlSeries = systemDetail.metrics.find((metric) => metric.name.includes('低密度脂蛋白'));
  requireCondition(ldlSeries?.points.length === 4, `SMOKE_UPDATED_SERIES_POINT_COUNT_MISMATCH: ${ldlSeries?.points.length ?? 0}`);
  requireCondition(systemDetail.analysis?.status === 'current', `SMOKE_SYSTEM_ANALYSIS_NOT_CURRENT: ${systemDetail.analysis?.status ?? 'missing'}`);
  requireCondition(systemDetail.analysis.headline === analysisCandidate.headline, 'SMOKE_SYSTEM_ANALYSIS_HEADLINE_NOT_UPDATED');

  process.stdout.write(`${JSON.stringify({
    userData,
    personId,
    newDocumentId: documentId,
    factRevision: { before: beforeFactRevision, after: service.store.getFactRevision(personId) },
    ldlSeriesPoints: ldlSeries.points.length,
    systemAnalysis: { status: systemDetail.analysis.status, headline: systemDetail.analysis.headline },
    proposal: { id: afterPlan.proposals[0]!.id, status: afterPlan.proposals[0]!.status, duplicateCount: afterPlan.proposals.length - 1 },
    adoptedAction: {
      id: afterAction.id,
      preserved: true,
      userGoal: afterAction.userGoal,
      selectedStartingOption: afterAction.selectedStartingOption
    }
  }, null, 2)}\n`);
} finally {
  service.close();
}
