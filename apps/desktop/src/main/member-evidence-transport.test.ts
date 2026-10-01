import { describe, expect, it } from 'vitest';
import type { MemberEvidencePackageV3, MemberEvidenceRef } from '@contracts';
import {
  assertAssessmentPromptFits, createMemberEvidenceTransport, expandMemberEvidence,
  isAssessmentContextLimit, MAX_ASSESSMENT_PROMPT_CHARS,
  restoreMemberEvidenceReferences, aliasMemberEvidenceReferences
} from './member-evidence-transport.js';

function fixture(): MemberEvidencePackageV3 {
  const quote = '合成报告原文：左眼矫正视力 ≤5.0；右眼矫正视力 4.8。检查日期仅标明 2025-06，不能补成六月一日。';
  const evidence: MemberEvidenceRef = {
    id: 'evidence-000000000000000000000001', kind: 'observation',
    observationId: 'observation-000000000000000001', eventId: 'event-000000000000000000000001',
    documentId: 'document-000000000000000000001', sourceSpanId: 'span-000000000000000000000001',
    knowledgeId: null, label: '合成报告', locator: '第 2 页', quote
  };
  return {
    identity: { personId: 'person-00000000000000000000001', birthYear: null, genderContext: null, source: 'user_profile' },
    facts: [{
      observationId: evidence.observationId!, documentId: evidence.documentId!, originalName: '左眼矫正视力',
      modelStandardNameCandidate: null, rawValue: '≤5.0', valueKind: 'numeric', qualifier: 'lte',
      unit: null, referenceRange: null, clinicalDate: '2025-06', reportedAbnormalFlag: 'unknown',
      specimen: null, method: '未散瞳', bodySite: '左眼', systemIds: [], evidenceIds: [evidence.id], sourceKind: 'report'
    }],
    evidenceCatalog: [evidence, { ...evidence, id: 'evidence-000000000000000000000002', documentId: 'document-000000000000000000002' }],
    trends: [{ id: 'trend-000000000000000000000001', systemIds: [], payload: {
      time: { value: '2025-06', precision: 'month' }, trendFacts: { slope: null, count: 1 },
      points: [{ value: '≤5.0', evidence: { quote, sourceSpanId: evidence.sourceSpanId }, evidenceSources: [evidence] }],
      preserved: { $quote: 0, text: 'ref:1', $object: null }
    } }],
    personalContext: [], unresolvedScope: [{ documentId: evidence.documentId!, reasonCodes: ['DATE_UNKNOWN'] }],
    existingActions: [], knowledge: [], criteriaSets: [], partitionResults: []
  };
}

describe('成员综合资料无损传输', () => {
  it('完整还原数值、比较符、左右侧、日期精度、空值和所有依据，原包不变', () => {
    const source = fixture();
    const before = structuredClone(source);
    const transport = createMemberEvidenceTransport(source);
    expect(expandMemberEvidence(transport.packet, transport.referenceIds)).toEqual(source);
    expect(source).toEqual(before);
    expect(transport.packet.quotes).toHaveLength(1);
    expect(JSON.stringify(transport.packet)).toContain('"$evidence":0');
    expect(JSON.stringify(transport.packet)).toContain('"$object"');
    const aliased = expandMemberEvidence(transport.packet);
    expect(aliased.identity).toEqual(source.identity);
    expect(aliased.facts[0]!.rawValue).toBe('≤5.0');
    expect(aliased.facts[0]!.evidenceIds[0]).toMatch(/^ref:/);
    expect(aliased.evidenceCatalog[0]!.documentId).not.toBe(aliased.evidenceCatalog[1]!.documentId);
  });

  it('按完整依据去重而非只看原文，相同文本的不同页和文件仍分别保留', () => {
    const source = fixture();
    const evidence = source.evidenceCatalog[0]!;
    const reordered = Object.fromEntries(Object.entries(evidence).reverse());
    source.trends[0]!.payload = { evidenceSources: [reordered, { ...evidence, locator: '第 3 页' }] };
    const transport = createMemberEvidenceTransport(source);
    expect(JSON.stringify(transport.packet)).toContain('"$evidence":0');
    expect(expandMemberEvidence(transport.packet, transport.referenceIds)).toEqual(source);
  });

  it('短编号只替换 ID 字段，不改正文；未知引用不能被伪造为有效依据', () => {
    const source = fixture();
    source.existingActions.push({ id: 'ref:1', title: '合成事项', detail: '', status: 'open', systemIds: [] });
    const transport = createMemberEvidenceTransport(source);
    expect(Object.keys(transport.referenceIds).every((id) => id.startsWith('ref2:'))).toBe(true);
    const original = {
      personId: source.identity.personId, text: source.evidenceCatalog[0]!.id,
      evidenceIds: [source.evidenceCatalog[0]!.id], counterEvidenceIds: [source.evidenceCatalog[1]!.id],
      trendIds: [source.trends[0]!.id], criteriaBasis: { requirements: [{ evidenceIds: [source.evidenceCatalog[0]!.id] }] }
    };
    const aliased = aliasMemberEvidenceReferences(original, transport.referenceIds);
    expect(aliased.text).toBe(original.text);
    expect(restoreMemberEvidenceReferences(aliased, transport.referenceIds)).toEqual(original);
    expect(restoreMemberEvidenceReferences({ evidenceIds: ['ref2:999999'], text: 'ref2:1' }, transport.referenceIds))
      .toEqual({ evidenceIds: ['ref2:999999'], text: 'ref2:1' });
    expect(expandMemberEvidence(transport.packet, transport.referenceIds)).toEqual(source);
  });

  it('大量重复依据精简后仍保留全部记录，不靠截断满足输入容量', () => {
    const source = fixture();
    const evidence = source.evidenceCatalog[0]!;
    evidence.quote = '合成连续原文；'.repeat(500);
    source.trends = Array.from({ length: 300 }, (_, index) => ({
      id: `trend-long-synthetic-${String(index).padStart(10, '0')}`, systemIds: [],
      payload: { evidenceSources: [evidence], evidence: { quote: evidence.quote }, count: 1, value: `${index}` }
    }));
    const transport = createMemberEvidenceTransport(source);
    expect(JSON.stringify(source).length).toBeGreaterThan(1_048_576);
    expect(JSON.stringify(transport.packet).length).toBeLessThan(100_000);
    expect(expandMemberEvidence(transport.packet, transport.referenceIds)).toEqual(source);
    expect(expandMemberEvidence(transport.packet).trends).toHaveLength(300);
  });

  it('容量检查在边界内允许完整发送，超限明确停止；不把普通错误当容量问题', () => {
    expect(() => assertAssessmentPromptFits('a'.repeat(MAX_ASSESSMENT_PROMPT_CHARS))).not.toThrow();
    expect(() => assertAssessmentPromptFits('a'.repeat(MAX_ASSESSMENT_PROMPT_CHARS + 1)))
      .toThrow('MEMBER_ASSESSMENT_INPUT_TOO_LARGE');
    expect(isAssessmentContextLimit(new Error('CODEX_CONTEXT_WINDOW_EXCEEDED'))).toBe(true);
    expect(isAssessmentContextLimit(new Error('CODEX_RPC_ERROR:-32602:Input exceeds the maximum length of 1048576 characters.'))).toBe(true);
    expect(isAssessmentContextLimit(new Error('NETWORK_ERROR'))).toBe(false);
    expect(isAssessmentContextLimit(new Error('CODEX_RPC_ERROR:-32602:invalid schema'))).toBe(false);
  });
});
