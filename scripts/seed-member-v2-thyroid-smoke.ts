import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ObservationCandidate, SystemAnalysisCandidate, SystemAnalysisReview } from '../packages/contracts/src/index.ts';
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
  workspaceName: '甲状腺合成验收工作区',
  stayInTray: false,
  openAtLogin: false,
  notificationsEnabled: true,
  displayPreferences: { fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' },
  aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' }
}, null, 2)}\n`);

const service = new PersonalWorkspaceService(workspaceRoot, '甲状腺合成验收工作区', () => new Date('2026-09-21T09:00:00.000Z'));

try {
  requireCondition(service.getSnapshot(null).persons.length === 0, 'SMOKE_WORKSPACE_MUST_BE_EMPTY');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员乙', relation: '本人' });
  const sourceText = [
    '2024-05-01 TSH 4.8 mIU/L ↑，参考范围 0.27-4.2 mIU/L',
    '2025-05-01 血清促甲状腺激素 3.9 mIU/L，参考范围 0.27-4.2 mIU/L',
    '2025-05-01 明细重复来源：促甲状腺素 3.9 mIU/L',
    '2025-05-01 FT4 15.2 pmol/L，参考范围 12-22 pmol/L',
    '2025-05-01 T4 8.8 ng/mL，参考范围 4.5-12 ng/mL',
    '2025-05-01 TPOAb 88 IU/mL ↑，参考范围 0-34 IU/mL',
    '2025-05-01 甲状腺左叶结节：约 6×4 mm，边界尚清',
    '2025-05-01 甲状腺右叶结节：约 7×5 mm，边界尚清',
    '2026-08-20 甲状腺右叶近似区域见约 8×5 mm 结节，与前次是否同一病灶不确定'
  ].join('\n');
  const receipt = await service.importFiles([{ path: '/tmp/甲状腺语义合成报告.txt', bytes: Buffer.from(sourceText) }], personId);
  requireCondition(receipt.importedCount === 1, `SMOKE_THYROID_IMPORT_FAILED: ${JSON.stringify(receipt)}`);
  const document = service.getSnapshot(null).inbox.find((item) => item.displayName === '甲状腺语义合成报告.txt');
  requireCondition(document, 'SMOKE_THYROID_DOCUMENT_NOT_FOUND');
  const documentId = document.id;
  const bundle = service.store.getDocumentExtractionBundle(documentId);
  requireCondition(bundle.manifest.spans.length === 9, `SMOKE_THYROID_SPAN_COUNT_MISMATCH: ${bundle.manifest.spans.length}`);
  const spans = bundle.manifest.spans;
  const numeric = (
    localKey: string,
    originalName: string,
    standardNameCandidate: string,
    rawText: string,
    unitRaw: string,
    referenceRangeRaw: string,
    reportedAbnormalFlag: string,
    clinicalDate: string,
    spanIndexes: number[]
  ): ObservationCandidate => ({
    localKey,
    originalName,
    standardNameCandidate,
    value: { kind: 'numeric', rawText, decimal: rawText, comparator: 'eq' },
    unitRaw,
    referenceRangeRaw,
    reportedAbnormalFlag,
    specimen: '血清',
    method: '化学发光',
    bodySite: null,
    clinicalDate,
    evidence: spanIndexes.map((index, evidenceIndex) => ({
      sourceSpanId: spans[index]!.id,
      quote: spans[index]!.quote,
      ...(evidenceIndex === 0 ? {} : { sourceRole: 'duplicate_source' as const, duplicateBasis: 'report_structure' as const })
    })),
    issues: []
  });
  const finding = (
    localKey: string,
    originalName: string,
    rawText: string,
    bodySite: string,
    clinicalDate: string,
    spanIndex: number
  ): ObservationCandidate => ({
    localKey,
    originalName,
    standardNameCandidate: originalName,
    value: { kind: 'text', rawText },
    unitRaw: null,
    referenceRangeRaw: null,
    reportedAbnormalFlag: null,
    specimen: null,
    method: '超声',
    bodySite,
    clinicalDate,
    evidence: [{ sourceSpanId: spans[spanIndex]!.id, quote: spans[spanIndex]!.quote }],
    issues: []
  });
  const candidates: ObservationCandidate[] = [
    numeric('tsh-2024', 'TSH', '促甲状腺激素', '4.8', 'mIU/L', '0.27-4.2', '↑', '2024-05-01', [0]),
    numeric('tsh-2025', '血清促甲状腺激素', '促甲状腺激素', '3.9', 'mIU/L', '0.27-4.2', '正常', '2025-05-01', [1, 2]),
    numeric('ft4-2025', 'FT4', '游离甲状腺素', '15.2', 'pmol/L', '12-22', '正常', '2025-05-01', [3]),
    numeric('t4-2025', 'T4', '总甲状腺素', '8.8', 'ng/mL', '4.5-12', '正常', '2025-05-01', [4]),
    numeric('tpoab-2025', 'TPOAb', '甲状腺过氧化物酶抗体', '88', 'IU/mL', '0-34', '↑', '2025-05-01', [5]),
    finding('left-lesion-2025', '甲状腺左叶结节', '约 6×4 mm，边界尚清', '甲状腺左叶', '2025-05-01', 6),
    finding('right-lesion-2025', '甲状腺右叶结节', '约 7×5 mm，边界尚清', '甲状腺右叶', '2025-05-01', 7),
    finding('right-lesion-2026', '甲状腺右叶结节', '甲状腺右叶近似区域见约 8×5 mm 结节，与前次是否同一病灶不确定', '甲状腺右叶', '2026-08-20', 8)
  ];
  const issueId = service.store.saveExtractionReviewIssue({
    documentId,
    kind: 'field_conflict',
    severity: 'blocking',
    evidenceRefs: spans.map((span) => span.id),
    candidateOptions: candidates,
    candidateDiffs: candidates.map((candidate) => ({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] })),
    reasonCodes: ['SYNTHETIC_THYROID_SMOKE_FIXTURE'],
    documentRun: {
      coverageComplete: true,
      coveredSourceSpanIds: spans.map((span) => span.id),
      manifestSpanIds: spans.map((span) => span.id),
      chunkCount: 1
    }
  });
  service.acceptCorrectedFacts({ issueId, documentId, candidates });
  const report = service.store.listReportMetadata(personId).find((item) => item.documentId === documentId);
  requireCondition(report, 'SMOKE_THYROID_REPORT_METADATA_NOT_FOUND');
  service.updateReportMetadata({
    personId,
    reportId: report.reportId,
    expectedRevision: report.metadataRevision,
    title: '甲状腺语义合成报告',
    organization: '合成内分泌中心',
    department: '超声与检验联合',
    clinicalTime: { value: '2026-08-20', precision: 'day' },
    reason: '甲状腺成品旅程验收'
  });

  const endocrine = service.buildSystemEvidenceBundle(personId, 'endocrine_metabolic', 'synthetic-thyroid-model');
  requireCondition(endocrine.directFacts.length === 8, `SMOKE_THYROID_DIRECT_FACT_COUNT_MISMATCH: ${endocrine.directFacts.length}`);
  const allEvidenceIds = endocrine.directFacts.map((fact) => fact.evidence.id);
  const analysisCandidate: SystemAnalysisCandidate = {
    schemaVersion: 2,
    personId,
    systemId: 'endocrine_metabolic',
    inputSignature: endocrine.scope.inputSignature,
    headline: '甲状腺资料已按功能、抗体和超声发现分开整理；名称别名已归一，左右侧和不确定病灶仍保留区别。',
    dataQuality: 'partial',
    keyPoints: [
      {
        id: 'thyroid-lab-semantics',
        kind: 'fact_summary',
        text: 'TSH 与血清促甲状腺激素作为同一指标阅读；FT4 与总 T4 保持为两个不同检测概念，TPOAb 单独保留。',
        evidenceIds: allEvidenceIds.slice(0, 5),
        limitations: [],
        trendFactIds: endocrine.trends.filter((trend) => trend.conceptId === 'thyroid-tsh').map((trend) => trend.id)
      },
      {
        id: 'thyroid-ultrasound-sides',
        kind: 'fact_summary',
        text: '超声记录中的左叶与右叶分别保留；2026 年右叶近似区域是否与前次为同一病灶尚不确定，因此不计算增长。',
        evidenceIds: allEvidenceIds.slice(5),
        limitations: ['病灶身份未确认，不能把两次尺寸直接连成增长趋势。'],
        trendFactIds: []
      }
    ],
    topicSections: [{
      topicId: 'thyroid',
      title: '甲状腺',
      claimIds: ['thyroid-lab-semantics', 'thyroid-ultrasound-sides'],
      seriesIds: endocrine.trends.map((trend) => trend.id),
      findingIds: ['right-lesion-2025', 'right-lesion-2026', 'left-lesion-2025']
    }],
    conflicts: [{ text: '右叶两次超声所见是否为同一病灶尚不确定。', evidenceIds: allEvidenceIds.slice(6) }],
    dataGaps: [{ text: '缺少病灶唯一编号或明确对应关系。', consequence: '不计算尺寸增长，只并列展示原报告发现。' }],
    discussionPoints: []
  };
  const analysisReview: SystemAnalysisReview = {
    schemaVersion: 1,
    personId,
    systemId: 'endocrine_metabolic',
    inputSignature: endocrine.scope.inputSignature,
    overallSupported: true,
    itemReviews: [
      ...analysisCandidate.keyPoints.map((item) => ({
        itemId: item.id,
        supported: true,
        safe: true,
        trendConsistent: true,
        issue: null
      })),
      { itemId: 'conflict:0', supported: true, safe: true, trendConsistent: true, issue: null }
    ]
  };
  let turn = 0;
  const analysisResult = await new SystemAnalysisPipeline(service.store, {
    runStructuredTurn: async () => ({
      threadId: 'synthetic-thyroid-thread',
      turnId: `synthetic-thyroid-${++turn}`,
      output: turn === 1 ? analysisCandidate : analysisReview
    })
  }, undefined, undefined, undefined, 'synthetic-thyroid-model').process(personId, 'endocrine_metabolic');
  requireCondition(analysisResult.status === 'published', `SMOKE_THYROID_ANALYSIS_FAILED: ${JSON.stringify(analysisResult)}`);

  const detail = service.getBodySystemDetail(personId, 'endocrine_metabolic');
  const tsh = detail.metrics.find((metric) => metric.conceptId === 'thyroid-tsh');
  const ft4 = detail.metrics.find((metric) => metric.conceptId === 'thyroid-ft4');
  const totalT4 = detail.metrics.find((metric) => metric.conceptId === 'thyroid-total-t4');
  const left = detail.metrics.find((metric) => metric.name === '甲状腺左叶结节');
  const right = detail.metrics.find((metric) => metric.name === '甲状腺右叶结节');
  requireCondition(tsh?.points.length === 2, `SMOKE_TSH_ALIAS_NOT_MERGED: ${tsh?.points.length ?? 0}`);
  const latestTshPoint = tsh.points[1]!;
  requireCondition(latestTshPoint.duplicateSourceCount === 1 && (latestTshPoint.evidenceSources?.length ?? 0) === 2, 'SMOKE_TSH_DUPLICATE_SOURCE_NOT_PRESERVED');
  requireCondition(ft4 && totalT4 && ft4.id !== totalT4.id, 'SMOKE_FREE_AND_TOTAL_T4_MERGED');
  requireCondition(left?.points.length === 1 && right?.points.length === 2, 'SMOKE_THYROID_SIDES_NOT_SEPARATED');
  requireCondition(right.trendFacts.usablePointCount === 0 && right.trendFacts.direction === 'insufficient', 'SMOKE_UNCERTAIN_LESION_GROWTH_WAS_CALCULATED');
  requireCondition(detail.analysis?.status === 'current', 'SMOKE_THYROID_ANALYSIS_NOT_CURRENT');

  process.stdout.write(`${JSON.stringify({
    userData,
    personId,
    documentId,
    acceptedFacts: service.store.listAcceptedObservations(personId).length,
    systemAnalysis: { status: detail.analysis.status, headline: detail.analysis.headline },
    semantics: {
      tshAliasPointCount: tsh.points.length,
      tshDuplicateSourceCount: latestTshPoint.duplicateSourceCount,
      freeAndTotalT4Separated: ft4.id !== totalT4.id,
      leftFindingCount: left.points.length,
      rightFindingCount: right.points.length,
      uncertainLesionGrowthCalculated: right.trendFacts.usablePointCount > 1
    }
  }, null, 2)}\n`);
} finally {
  service.close();
}
