import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionResult, SystemAnalysisCandidate, SystemAnalysisReview } from '@contracts';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { SystemAnalysisPipeline } from './system-analysis-pipeline.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(options: { sameSpanPair?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-system-analysis-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-21T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
  await service.importFiles([{
    path: '/tmp/虚构血脂报告.txt',
    bytes: Buffer.from(options.sameSpanPair
      ? '2026-09-17 LDL-C 4.2 mmol/L，甘油三酯 1.6 mmol/L\n汇总页 LDL-C 4.2 mmol/L'
      : '2026-09-17 LDL-C 4.2 mmol/L，参考范围 0-3.4 mmol/L')
  }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const manifestSpans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const spanId = manifestSpans[0]!.id;
  const extraction: ExtractionResult = {
    schemaVersion: 1,
    documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: manifestSpans.map((span) => span.id),
    candidates: [{
      localKey: 'ldl-1', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4 mmol/L', reportedAbnormalFlag: '偏高',
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
      evidence: options.sameSpanPair ? [
        { sourceSpanId: spanId, quote: '2026-09-17 LDL-C 4.2 mmol/L', sourceRole: 'primary' },
        { sourceSpanId: manifestSpans[1]!.id, quote: '汇总页 LDL-C 4.2 mmol/L', sourceRole: 'duplicate_source', duplicateBasis: 'report_structure' }
      ] : [{ sourceSpanId: spanId, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
    }, ...(options.sameSpanPair ? [{
      localKey: 'tg-1', originalName: '甘油三酯', standardNameCandidate: '甘油三酯',
      value: { kind: 'numeric' as const, rawText: '1.6', decimal: '1.6', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-1.7 mmol/L', reportedAbnormalFlag: '正常',
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
      evidence: [{ sourceSpanId: spanId, quote: '甘油三酯 1.6 mmol/L' }], issues: []
    }] : [])]
  };
  await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async () => ({ threadId: 'extract-thread', turnId: 'extract-turn', output: extraction })
  }).process(documentId);
  return { service, personId };
}

describe('SystemAnalysisPipeline', () => {
  it('只有完整引用且独立复核通过时发布，相同签名不重跑', async () => {
    const { service, personId } = await setup();
    const bundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    const candidate: SystemAnalysisCandidate = {
      schemaVersion: 2,
      personId,
      systemId: 'cardiovascular',
      inputSignature: bundle.scope.inputSignature,
      headline: '现有血脂资料中，LDL-C 带有原报告偏高标记。',
      dataQuality: 'partial',
      keyPoints: [{
        id: 'point-ldl',
        kind: 'fact_summary',
        text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。',
        evidenceIds: [bundle.directFacts[0]!.evidence.id],
        limitations: [],
        trendFactIds: []
      }],
      topicSections: [{ topicId: 'lipids', title: '血脂', claimIds: ['point-ldl'], seriesIds: [], findingIds: [] }],
      conflicts: [],
      dataGaps: [{ text: '只有一次可用数值。', consequence: '不能判断变化趋势。' }],
      discussionPoints: []
    };
    const review: SystemAnalysisReview = {
      schemaVersion: 1,
      personId,
      systemId: 'cardiovascular',
      inputSignature: bundle.scope.inputSignature,
      overallSupported: true,
      itemReviews: [{ itemId: 'point-ldl', supported: true, safe: true, trendConsistent: true, issue: null }]
    };
    let call = 0;
    const allowWebSearch: Array<boolean | undefined> = [];
    const pipeline = new SystemAnalysisPipeline(service.store, {
      runStructuredTurn: async (input) => {
        allowWebSearch.push(input.allowWebSearch);
        call += 1;
        return { threadId: 'system-thread', turnId: `system-${call}`, output: call === 1 ? candidate : review };
      }
    });
    await expect(pipeline.process(personId, 'cardiovascular')).resolves.toMatchObject({ status: 'published' });
    expect(service.store.listSystemAnalysisSnapshots(personId, true)).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        systemId: 'cardiovascular',
        headline: candidate.headline,
        review: expect.objectContaining({ status: 'passed' })
      })
    ]);
    expect(service.getBodySystemDetail(personId, 'cardiovascular').analysis).toMatchObject({ headline: candidate.headline });
    const unrelatedGoal = service.store.createManualNote({
      personId,
      kind: 'goal',
      immutableText: '希望把日常生活安排得更有规律',
      effectiveDate: null,
      structuredFields: {},
      expectedContextRevision: 0
    });
    expect(service.store.listSystemAnalysisSnapshots(personId, true)).toHaveLength(1);
    expect(service.buildSystemEvidenceBundle(personId, 'cardiovascular').coverage.excludedContextIds).toContain(unrelatedGoal.id);
    await expect(pipeline.process(personId, 'cardiovascular')).resolves.toEqual({
      status: 'skipped', systemId: 'cardiovascular', reason: 'signature_current'
    });
    expect(call).toBe(2);
    expect(allowWebSearch).toEqual([false, false]);
    service.store.createManualNote({
      personId,
      kind: 'constraint',
      immutableText: '本人补充：膝关节不适，日常活动要避免过度负重。',
      effectiveDate: '2026-09-20',
      structuredFields: {},
      expectedContextRevision: 1
    });
    expect(service.getBodySystemDetail(personId, 'cardiovascular').analysis).toMatchObject({
      status: 'stale',
      headline: candidate.headline
    });
    service.close();
  });

  it('同一页的多条事实使用唯一证据身份，同时保留重复来源与真实事件', async () => {
    const { service, personId } = await setup({ sameSpanPair: true });
    const bundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(bundle.directFacts).toHaveLength(2);
    const primaryIds = bundle.directFacts.map((fact) => fact.evidence.id);
    expect(new Set(primaryIds).size).toBe(2);
    expect(bundle.directFacts[0]!.evidenceSources).toHaveLength(2);
    expect(new Set(bundle.directFacts[0]!.evidenceSources.map((item) => item.id)).size).toBe(2);
    const realEventId = service.store.listReportMetadata(personId)[0]!.eventId;
    expect(bundle.directFacts.every((fact) => fact.evidence.eventId === realEventId)).toBe(true);
    expect(bundle.events).toEqual([expect.objectContaining({ id: realEventId, factCount: 2 })]);
    const legacyEvidenceId = `evidence-${bundle.directFacts[0]!.evidence.sourceSpanId}`;
    expect(service.getMemberEvidenceBundle(personId, [legacyEvidenceId])).toMatchObject({
      items: [expect.objectContaining({ id: legacyEvidenceId, kind: 'source_span', observationId: null })],
      missingIds: []
    });
    service.close();
  });

  it('引用不存在时在本地拒绝，不发起二次复核也不要求用户确认', async () => {
    const { service, personId } = await setup();
    const bundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    const unsupported: SystemAnalysisCandidate = {
      schemaVersion: 2,
      personId,
      systemId: 'cardiovascular',
      inputSignature: bundle.scope.inputSignature,
      headline: '资料需要进一步整理。',
      dataQuality: 'partial',
      keyPoints: [{
        id: 'unsupported', kind: 'fact_summary', text: '一条没有依据的说明。',
        evidenceIds: ['missing-evidence'], limitations: [], trendFactIds: []
      }],
      topicSections: [], conflicts: [], dataGaps: [], discussionPoints: []
    };
    let call = 0;
    const result = await new SystemAnalysisPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'system-thread', turnId: `system-${++call}`, output: unsupported })
    }).process(personId, 'cardiovascular');
    expect(result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('evidence_mismatch') });
    expect(call).toBe(1);
    expect(service.store.listSystemAnalysisSnapshots(personId, true)).toHaveLength(0);
    expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(0);
    service.close();
  });
});
