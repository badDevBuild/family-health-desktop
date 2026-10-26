import { describe, expect, it, vi } from 'vitest';
import type { MemberEvidencePackageV3, MemberEvidenceRef } from '@contracts';
import { DOCUMENTED_PLAN_NEUTRAL_TITLE, inspectDocumentedPlanEvidence, memberAssessmentCandidateV3Schema } from '@contracts';
import { materializeWholeExcerptMemberCatalog } from './member-whole-excerpt-evidence.js';
import { createMemberAnalysisTransport } from './member-analysis-package.js';
import { buildAssessmentRepairRequest } from './member-assessment-pipeline.js';

type SourceOwner = Parameters<typeof materializeWholeExcerptMemberCatalog>[2][number];
const personId = 'synthetic-person';
const documentId = 'synthetic-document';
const observationId = 'synthetic-observation';
const sourceSpanId = 'synthetic-original-excerpt';
function owner(): SourceOwner {
  return { id: observationId, personId, documentId, sourceSpanId,
    evidence: [{ sourceSpanId, quote: null }], clinicalContext: { version: 1, status: 'complete', conditions: [] } };
}
function reference(): MemberEvidenceRef {
  return { id: 'synthetic-evidence', kind: 'observation', observationId, documentId, sourceSpanId,
    eventId: null, knowledgeId: null, label: '合成原件', locator: null, quote: null };
}
function packageFixture(refs: MemberEvidenceRef[]): MemberEvidencePackageV3 {
  return { identity: { personId, birthYear: null, genderContext: null, source: 'user_profile' },
    facts: [{ observationId, documentId, originalName: '合成指标', modelStandardNameCandidate: null,
      rawValue: '7', valueKind: 'numeric', qualifier: 'eq', unit: 'U/L', referenceRange: null,
      clinicalDate: null, reportedAbnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
      systemIds: [], evidenceIds: refs.map((ref) => ref.id), sourceKind: 'report',
      clinicalContext: { version: 1, status: 'complete', conditions: [] } }],
    evidenceCatalog: refs, trends: [{ id: 'synthetic-unknown-trend', systemIds: [],
      payload: { unknown: true, points: [{ evidence: refs[0], clinicalDate: null }] } }],
    personalContext: [], unresolvedScope: [], existingActions: [], knowledge: [], criteriaSets: [], partitionResults: [] };
}

describe('成员综合本机目录的整段原件引用', () => {
  it('仅null引文按原来明确的同成员、文档及摘录ID读取全文，原目录和观测不变', () => {
    const input = reference(); const observation = owner(); const before = structuredClone({ input, observation });
    const quote = '  合成原文\n请于4周后复查合成指标。  ';
    const store = { getTrustedDirectOriginalExcerptQuote: vi.fn(() => quote) };
    const result = materializeWholeExcerptMemberCatalog(store, personId, [observation], [input]);
    expect(result).toEqual([{ ...input, quote }]); expect(result[0]).not.toBe(input);
    expect(store.getTrustedDirectOriginalExcerptQuote).toHaveBeenCalledWith(personId, documentId, sourceSpanId);
    expect({ input, observation }).toEqual(before);
  });

  it.each(['显式引文', '', '与原件不符的显式引文'])('非null的%s不被全文覆盖或猜测修正', (quote) => {
    const input = { ...reference(), quote };
    const store = { getTrustedDirectOriginalExcerptQuote: vi.fn(() => '另一段完整原文') };
    expect(materializeWholeExcerptMemberCatalog(store, personId, [owner()], [input])).toEqual([input]);
    expect(store.getTrustedDirectOriginalExcerptQuote).not.toHaveBeenCalled();
  });

  it.each(['wrong-person', 'wrong-document', 'wrong-observation', 'undeclared-source', 'no-observation', 'no-document', 'no-source', 'knowledge'] as const)('%s不扩大引用范围或借别的事实补全文', (problem) => {
      const input = reference(); const observation = owner();
      if (problem === 'wrong-person') observation.personId = 'synthetic-other-person';
      if (problem === 'wrong-document') input.documentId = 'synthetic-other-document';
      if (problem === 'wrong-observation') input.observationId = 'synthetic-other-observation';
      if (problem === 'undeclared-source') input.sourceSpanId = 'synthetic-unreferenced-excerpt';
      if (problem === 'no-observation') input.observationId = null;
      if (problem === 'no-document') input.documentId = null;
      if (problem === 'no-source') input.sourceSpanId = null;
      if (problem === 'knowledge') input.kind = 'knowledge';
      const store = { getTrustedDirectOriginalExcerptQuote: vi.fn(() => '不得借用的合成原文') };
      expect(materializeWholeExcerptMemberCatalog(store, personId, [observation], [input])).toEqual([input]);
      expect(store.getTrustedDirectOriginalExcerptQuote).not.toHaveBeenCalled();
    });

  it('存储层不证明出处时保持null，不用观测结果或主来源替代', () => {
    const input = reference(); const store = { getTrustedDirectOriginalExcerptQuote: vi.fn(() => null) };
    expect(materializeWholeExcerptMemberCatalog(store, personId, [owner()], [input])).toEqual([input]);
  });

  it('同一原摘录在一次目录转换内仅查一次，但跨文档不共享缓存', () => {
    const input = reference(); const second = { ...input, id: 'second-reference' };
    const otherOwner = { ...owner(), id: 'other-observation', documentId: 'other-document' };
    const otherRef = { ...input, id: 'other-reference', observationId: otherOwner.id, documentId: otherOwner.documentId };
    const store = { getTrustedDirectOriginalExcerptQuote: vi.fn((_person: string, doc: string) => `合成 ${doc}`) };
    const result = materializeWholeExcerptMemberCatalog(store, personId, [owner(), otherOwner], [input, second, otherRef]);
    expect(store.getTrustedDirectOriginalExcerptQuote).toHaveBeenCalledTimes(2);
    expect(result.map((item) => item.quote)).toEqual(['合成 synthetic-document', '合成 synthetic-document', '合成 other-document']);
  });

  it('只消除真实整段引用丢失，不放宽正文、期限、否定或原安排匹配', () => {
    const input = reference(); const quote = '建议4周后复查合成指标。';
    const action = { kind: 'documented_plan' as const, timingBasis: 'documented' as const,
      title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote, timing: '4周后', evidenceIds: [input.id] };
    expect(inspectDocumentedPlanEvidence(action, [input]).unsupportedField).toBe('source');
    const refs = materializeWholeExcerptMemberCatalog({ getTrustedDirectOriginalExcerptQuote: () => quote }, personId, [owner()], [input]);
    expect(inspectDocumentedPlanEvidence(action, refs)).toMatchObject({ unsupportedField: null, titleSupported: true });
    expect(inspectDocumentedPlanEvidence({ ...action, firstStep: '建议4周后复查另一项检查。' }, refs).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...action, timing: '2周后' }, refs).unsupportedField).toBe('timing');
    const negated = materializeWholeExcerptMemberCatalog({ getTrustedDirectOriginalExcerptQuote: () => '未建议复查合成指标。' }, personId, [owner()], [input]);
    expect(inspectDocumentedPlanEvidence(action, negated).unsupportedField).not.toBeNull();
  });

  it.each(['complete', 'unresolved', 'legacy'] as const)('本机目录补齐不向P02的%s事实或未知趋势注入整原文副本', (status) => {
    const refs = [reference()]; const evidencePackage = packageFixture(refs);
    evidencePackage.facts[0]!.clinicalContext = status === 'legacy' ? null : { version: 1, status, conditions: [] };
    const analysisEvidenceCatalog = [...evidencePackage.evidenceCatalog];
    const before = createMemberAnalysisTransport(evidencePackage).packet;
    const originalTrends = structuredClone(evidencePackage.trends);
    const quote = `synthetic-long-original-marker ${'合成来源正文'.repeat(3000)}`;
    evidencePackage.evidenceCatalog = materializeWholeExcerptMemberCatalog(
      { getTrustedDirectOriginalExcerptQuote: () => quote }, personId, [owner()], evidencePackage.evidenceCatalog);
    const after = createMemberAnalysisTransport(evidencePackage, analysisEvidenceCatalog).packet;
    expect(evidencePackage.evidenceCatalog[0]!.quote).toBe(quote);
    expect(evidencePackage.trends).toEqual(originalTrends);
    expect(refs[0]!.quote).toBeNull();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('synthetic-long-original-marker');
  });

  it('传输隔离不丢掉unresolved事实原已声明的必要原句或条件', () => {
    const wholeRef = reference();
    const explicitRef = { ...wholeRef, id: 'explicit-existing-ref', quote: '合成既有检查条件：采样条件未知。' };
    const evidencePackage = packageFixture([wholeRef, explicitRef]);
    evidencePackage.facts[0]!.clinicalContext = { version: 1, status: 'unresolved', conditions: [] };
    const analysisEvidenceCatalog = [...evidencePackage.evidenceCatalog];
    const before = createMemberAnalysisTransport(evidencePackage).packet;
    evidencePackage.evidenceCatalog = materializeWholeExcerptMemberCatalog(
      { getTrustedDirectOriginalExcerptQuote: () => 'synthetic-local-only-full-original' }, personId, [owner()], evidencePackage.evidenceCatalog);
    const after = createMemberAnalysisTransport(evidencePackage, analysisEvidenceCatalog).packet;
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toContain(explicitRef.quote);
    expect(JSON.stringify(after)).not.toContain('synthetic-local-only-full-original');
    expect(analysisEvidenceCatalog[0]!.quote).toBeNull();
  });

  it('P03只发送原来明确引用的原句，保持项目日期，不扩读不相关目录正文', () => {
    const cited = reference(); const unrelated = { ...cited, id: 'unrelated-evidence', sourceSpanId: 'synthetic-other-excerpt' };
    const observation = owner(); observation.evidence.push({ sourceSpanId: unrelated.sourceSpanId!, quote: null });
    const quote = '建议4周后复查合成指标。';
    const catalog = materializeWholeExcerptMemberCatalog({ getTrustedDirectOriginalExcerptQuote: (_person, _doc, span) =>
      span === sourceSpanId ? quote : 'synthetic-unrelated-original-marker' }, personId, [observation], [cited, unrelated]);
    const candidate = memberAssessmentCandidateV3Schema.parse({ schemaVersion: 3, personId, inputSignature: '0'.repeat(64),
      mode: 'full', requestedSystemIds: [],
      overview: { id: 'overview', headline: '合成概况', summary: '仅用于引用转换测试', claimIds: [], actionIds: [], limitations: [] },
      systems: [], claims: [], questions: [], knowledgeSources: [], actions: [{
        id: 'synthetic-plan', dedupeKey: 'synthetic-plan-key', systemIds: [], claimIds: [], kind: 'documented_plan',
        title: DOCUMENTED_PLAN_NEUTRAL_TITLE, why: '保留合成来源安排', firstStep: '建议4周后复查另一项。',
        timing: '4周后', timingBasis: 'documented', reviewPlan: null, caution: null, urgency: 'routine',
        evidenceIds: [cited.id], knowledgeSourceIds: []
      }] });
    const request = buildAssessmentRepairRequest(candidate, ['documented_plan_instruction_not_proven:synthetic-plan'], catalog,
      [{ observationId, clinicalDate: null }]);
    expect(request.targets).toEqual(['synthetic-plan']);
    expect(request.targetDetails[0]!.sourceQuotes).toEqual([{ evidenceId: cited.id, quote, clinicalDate: null }]);
    expect(JSON.stringify(request)).not.toContain('synthetic-unrelated-original-marker');
    expect(cited.quote).toBeNull();
  });
});
