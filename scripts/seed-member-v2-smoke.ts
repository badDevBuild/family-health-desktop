import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SystemAnalysisCandidate, SystemAnalysisReview } from '../packages/contracts/src/index.ts';
import { SystemAnalysisPipeline } from '../apps/desktop/src/main/system-analysis-pipeline.ts';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.ts';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
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
  workspaceName: '合成验收工作区',
  stayInTray: false,
  openAtLogin: false,
  notificationsEnabled: true,
  displayPreferences: { fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' },
  aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' }
}, null, 2)}\n`);

const now = () => new Date('2026-09-21T08:00:00.000Z');
const service = new PersonalWorkspaceService(workspaceRoot, '合成验收工作区', now);

try {
  if (service.getSnapshot(null).persons.length > 0) throw new Error('SMOKE_WORKSPACE_MUST_BE_EMPTY');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员甲', relation: '本人' });
  const sourceText = [
    '2022-02-10 LDL-C 3.1 mmol/L，参考范围 0-3.4 mmol/L',
    '2024-08-18 低密度脂蛋白 3.6 mmol/L ↑，参考范围 0-3.4 mmol/L',
    '2026-09-12 低密度脂蛋白胆固醇 4.2 mmol/L ↑，参考范围 0-3.4 mmol/L',
    '2026-09-12 血清促甲状腺激素 TSH 6.54 mIU/ml ↑，参考范围 0.35-5.10 mIU/ml'
  ].join('\n');
  await service.importFiles([{
    path: '/tmp/合成年度健康报告.txt',
    bytes: Buffer.from(sourceText)
  }], personId);

  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const bundle = service.store.getDocumentExtractionBundle(documentId);
  if (bundle.manifest.spans.length !== 4) {
    throw new Error(`SMOKE_SOURCE_SPAN_COUNT_MISMATCH: ${bundle.manifest.spans.length}`);
  }
  const facts = [
    { key: 'ldl-2022', originalName: 'LDL-C', standardName: '低密度脂蛋白胆固醇', value: '3.1', unit: 'mmol/L', range: '0-3.4', flag: '正常', date: '2022-02-10', specimen: '血清' },
    { key: 'ldl-2024', originalName: '低密度脂蛋白', standardName: '低密度脂蛋白胆固醇', value: '3.6', unit: 'mmol/L', range: '0-3.4', flag: '↑', date: '2024-08-18', specimen: '血清' },
    { key: 'ldl-2026', originalName: '低密度脂蛋白胆固醇', standardName: '低密度脂蛋白胆固醇', value: '4.2', unit: 'mmol/L', range: '0-3.4', flag: '↑', date: '2026-09-12', specimen: '血清' },
    { key: 'tsh-2026', originalName: '血清促甲状腺激素 TSH', standardName: '促甲状腺激素', value: '6.54', unit: 'mIU/ml', range: '0.35-5.10', flag: '↑', date: '2026-09-12', specimen: '血清' }
  ];
  const candidates = bundle.manifest.spans.map((span, index) => {
    const fact = facts[index]!;
    return {
      localKey: fact.key,
      originalName: fact.originalName,
      standardNameCandidate: fact.standardName,
      value: { kind: 'numeric' as const, rawText: fact.value, decimal: fact.value, comparator: 'eq' as const },
      unitRaw: fact.unit,
      referenceRangeRaw: fact.range,
      reportedAbnormalFlag: fact.flag,
      specimen: fact.specimen,
      method: null,
      bodySite: null,
      clinicalDate: fact.date,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }],
      issues: []
    };
  });
  const issueId = service.store.saveExtractionReviewIssue({
    documentId,
    kind: 'field_conflict',
    severity: 'blocking',
    evidenceRefs: bundle.manifest.spans.map((span) => span.id),
    candidateOptions: candidates,
    candidateDiffs: candidates.map((candidate) => ({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] })),
    reasonCodes: ['SYNTHETIC_SMOKE_FIXTURE'],
    documentRun: {
      coverageComplete: true,
      coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
      manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
      chunkCount: 1
    }
  });
  service.acceptCorrectedFacts({ issueId, documentId, candidates });

  const report = service.store.listReportMetadata(personId)[0]!;
  service.updateReportMetadata({
    personId,
    reportId: report.reportId,
    expectedRevision: report.metadataRevision,
    title: '合成年度健康报告',
    organization: '合成健康中心',
    department: '健康管理科',
    clinicalTime: { value: '2026-09-12', precision: 'day' },
    reason: '合成界面验收数据'
  });
  service.store.createManualNote({
    personId,
    kind: 'goal',
    immutableText: '希望从容易坚持的日常活动开始，并观察身体感受。',
    effectiveDate: null,
    structuredFields: {},
    expectedContextRevision: 0
  });

  const cardiovascular = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'synthetic-smoke-model');
  const analysisCandidate: SystemAnalysisCandidate = {
    schemaVersion: 2,
    personId,
    systemId: 'cardiovascular',
    inputSignature: cardiovascular.scope.inputSignature,
    headline: '现有记录显示低密度脂蛋白胆固醇连续三次升高，最近一次带有原报告偏高标记。',
    dataQuality: 'partial',
    keyPoints: [{
      id: 'synthetic-ldl-trend',
      kind: 'trend_description',
      text: '低密度脂蛋白胆固醇从 3.1 升至 4.2 mmol/L；最近一次高于该报告参考上限 3.4 mmol/L。',
      evidenceIds: cardiovascular.directFacts.map((fact) => fact.evidence.id),
      limitations: ['当前只有三次合成记录，不能替代医生结合完整病史判断。'],
      trendFactIds: cardiovascular.trends.map((trend) => trend.id)
    }],
    topicSections: [{
      topicId: 'blood-lipids',
      title: '血脂',
      claimIds: ['synthetic-ldl-trend'],
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
    itemReviews: [{ itemId: 'synthetic-ldl-trend', supported: true, safe: true, trendConsistent: true, issue: null }]
  };
  let systemTurn = 0;
  const analysisResult = await new SystemAnalysisPipeline(service.store, {
    runStructuredTurn: async () => ({
      threadId: 'synthetic-system-thread',
      turnId: `synthetic-system-${++systemTurn}`,
      output: systemTurn === 1 ? analysisCandidate : analysisReview
    })
  }, undefined, undefined, undefined, 'synthetic-smoke-model').process(personId, 'cardiovascular');
  if (analysisResult.status !== 'published') throw new Error(`SMOKE_SYSTEM_ANALYSIS_FAILED: ${JSON.stringify(analysisResult)}`);

  const observations = service.store.listAcceptedObservations(personId);
  const ldlObservationIds = observations
    .filter((observation) => observation.conceptKey.toLocaleLowerCase().includes('ldl') || observation.conceptKey.includes('低密度'))
    .map((observation) => observation.id);
  service.store.publishDerivedSnapshot({
    candidate: {
      schemaVersion: 1,
      personId,
      factRevision: service.store.getFactRevision(personId),
      dataQuality: 'partial',
      claims: [{
        id: 'synthetic-action-claim',
        organId: 'cardiovascular',
        level: 'action',
        title: '带着连续三次血脂结果咨询医生',
        explanation: '最近一次低密度脂蛋白胆固醇带有原报告偏高标记；可以带着原报告请医生结合个人情况判断。',
        evidenceObservationIds: ldlObservationIds,
        boundaryNote: '这不是诊断，也不提供用药建议。'
      }],
      lifestyleGuidance: [{
        id: 'synthetic-guidance-walk',
        dedupeKey: 'sustainable-daily-activity',
        category: 'exercise',
        title: '从可持续的日常活动开始',
        goal: '建立可以长期保持的日常活动习惯',
        rationale: '先从低负担方案开始，更容易根据身体感受逐步调整。',
        detail: '可以先选择感觉舒适的短距离步行；出现胸痛、明显气促或其他不适时停止，并咨询专业人员。',
        steps: ['选择一段熟悉、平坦的路线', '从一次短距离步行开始', '只记录是否完成和身体感受'],
        startingOptions: ['饭后短距离慢走', '分两次完成同样的总时长'],
        scheduleSuggestion: '先从每周一至两次开始，再根据身体感受调整',
        trackingSuggestion: '记录日期、是否完成和身体感受，不追求一次达到固定强度。',
        constraints: ['出现不适时停止并咨询专业人员'],
        uncertainties: ['现有资料不足以给出个体化运动强度'],
        evidenceObservationIds: ldlObservationIds,
        generalKnowledgeEvidence: [{
          id: 'synthetic-knowledge-activity',
          sourceTitle: '合成验收用一般活动说明',
          sourceOrganization: '合成公共健康机构',
          sourceUrl: 'https://example.invalid/family-health/synthetic-activity',
          reviewedAt: '2026-09-21',
          supportedScope: '仅支持从可承受、低负担的日常活动开始这一通用方向'
        }],
        sourceKind: 'ai_proposed',
        relatedSystemIds: ['cardiovascular'],
        consultProfessional: true
      }]
    },
    expectedFactRevision: service.store.getFactRevision(personId),
    expectedContextRevision: service.store.getClinicalContextRevision(personId),
    promptVersion: 'synthetic-member-v2',
    rulesVersion: 'synthetic-safe-v1',
    modelId: 'synthetic-smoke-model'
  });

  process.stdout.write(`${JSON.stringify({
    userData,
    workspaceRoot,
    personId,
    documentId,
    acceptedFacts: observations.length,
    bodySystems: service.listBodySystems(personId).filter((system) => system.factCount > 0).map((system) => system.id),
    analysisStatus: analysisResult.status,
    lifestyleProposals: service.getLifestylePlan(personId).proposals.length
  }, null, 2)}\n`);
} finally {
  service.close();
}
