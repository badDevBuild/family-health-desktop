import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';
import { diagnoseDirectOriginalNoResult, directOriginalNoResultSourceKeys, isDirectOriginalExplicitNoResult } from './direct-original-no-result.js';

function fixture() {
  const ref = { sourceSpanId: 'e_blank', quote: null };
  const candidate: ObservationCandidate = { localKey: 'c_blank', originalName: '合成空白字段', standardNameCandidate: null,
    value: { kind: 'unknown', rawText: null, reason: 'original_blank' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] }, issues: [] };
  const reading: DirectOriginalReadingResult = { schemaVersion: 1, documentId: 'synthetic-document',
    pageReadings: [{ sourceSpanId: 'synthetic-page', status: 'read' }],
    sourceExcerpts: [{ localKey: 'e_blank', pageSourceSpanId: 'synthetic-page', quote: '合成空白字段', role: 'heading', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: 'synthetic-document', subject: { reportedName: null, confidence: 'absent', evidence: [] },
      coveredSourceSpanIds: ['synthetic-page'], candidates: [candidate] } };
  return { candidate, reading };
}

describe('模型明确空白的字段级出处，不生成医疗观测', () => {
  it.each([null, '合成空白字段'])('显式绑定同名完整字段标签%j，仅保留空白来源且不改写原回执', (quote) => {
    const f = fixture(); f.candidate.evidence[0]!.quote = quote;
    f.candidate.sourceBinding!.findingEvidence[0]!.quote = quote;
    const before = structuredClone(f);
    expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual(['e_blank']);
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(true);
    expect(f).toEqual(before);
  });

  it.each(['missing-binding', 'different-name', 'partial-quote', 'wrong-quote', 'blank-quote', 'duplicate-source',
    'ambiguous-excerpt', 'orphan-ref', 'orphan-page', 'partial-page', 'empty-page', 'uncertain', 'date', 'identity',
    'context', 'unreadable', 'not-performed', 'no-data', 'has-raw-text', 'blocking-issue', 'extra-invalid-ref'] as const)(
    '%s不让普通标题或其他unknown绕过结果确认', (kind) => {
      const f = fixture();
      if (kind === 'missing-binding') delete f.candidate.sourceBinding;
      if (kind === 'different-name') f.candidate.originalName = '另一字段';
      if (kind === 'partial-quote') f.candidate.sourceBinding!.findingEvidence[0]!.quote = '空白字段';
      if (kind === 'wrong-quote') f.candidate.evidence[0]!.quote = '另一引用';
      if (kind === 'blank-quote') f.candidate.evidence[0]!.quote = '  ';
      if (kind === 'duplicate-source') f.candidate.sourceBinding!.findingEvidence[0]!.sourceRole = 'duplicate_source';
      if (kind === 'ambiguous-excerpt') f.reading.sourceExcerpts.push({ ...f.reading.sourceExcerpts[0]! });
      if (kind === 'orphan-ref') f.candidate.evidence[0]!.sourceSpanId = 'missing-source';
      if (kind === 'orphan-page') f.reading.pageReadings = [];
      if (kind === 'partial-page') f.reading.pageReadings[0]!.status = 'partial';
      if (kind === 'empty-page') f.reading.pageReadings[0]!.status = 'no_medical_content';
      if (kind === 'uncertain') f.reading.sourceExcerpts[0]!.clarity = 'uncertain';
      if (kind === 'date' || kind === 'identity' || kind === 'context') f.reading.sourceExcerpts[0]!.role = kind;
      if (kind === 'unreadable') f.candidate.value = { kind: 'unknown', rawText: null, reason: 'unreadable' };
      if (kind === 'not-performed') f.candidate.value = { kind: 'unknown', rawText: null, reason: 'not_performed' };
      if (kind === 'no-data') f.candidate.value = { kind: 'unknown', rawText: null, reason: 'no_data' };
      if (kind === 'has-raw-text') f.candidate.value = { kind: 'unknown', rawText: '结果仍待判断', reason: 'original_blank' };
      if (kind === 'blocking-issue') f.candidate.issues = [{ code: 'blocking_source_uncertain', message: '合成不确定性' }];
      if (kind === 'extra-invalid-ref') f.candidate.sourceBinding!.headingEvidence.push({ sourceSpanId: 'missing-context', quote: null });
      expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(false);
      const diagnostics = diagnoseDirectOriginalNoResult(f.candidate, f.reading);
      if (kind === 'unreadable') expect(diagnostics).toEqual([]);
      else expect(diagnostics.length).toBeGreaterThan(0);
    });

  it.each(['original_blank', 'not_performed', 'no_data'])('原件明确%s的结果文字仍按finding来源保留，不要求伪造标题', (reason) => {
    const f = fixture(); f.reading.sourceExcerpts[0]!.role = 'finding'; f.reading.sourceExcerpts[0]!.quote = '合成未提供结果原话';
    f.candidate.value = { kind: 'unknown', rawText: null, reason };
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(true);
  });
});

describe('空白判定的只读结构化诊断', () => {
  it('通过的空白、非unknown和非明确空白类unknown均不生成修复诊断', () => {
    const f = fixture();
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toEqual([]);
    f.candidate.value = { kind: 'text', rawText: '合成文字结果' };
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toEqual([]);
    f.candidate.value = { kind: 'unknown', rawText: null, reason: 'unreadable' };
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toEqual([]);
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(false);
  });

  it.each([
    ['missing-source', 'NO_RESULT_SOURCE_MISSING', 'evidence[0].sourceSpanId'],
    ['ambiguous-source', 'NO_RESULT_SOURCE_AMBIGUOUS', 'evidence[0].sourceSpanId'],
    ['uncertain-source', 'NO_RESULT_SOURCE_NOT_CLEAR', 'evidence[0].sourceSpanId'],
    ['missing-page', 'NO_RESULT_PAGE_MISSING', 'evidence[0].sourceSpanId'],
    ['ambiguous-page', 'NO_RESULT_PAGE_AMBIGUOUS', 'evidence[0].sourceSpanId'],
    ['partial-page', 'NO_RESULT_PAGE_NOT_READ', 'evidence[0].sourceSpanId'],
    ['empty-quote', 'NO_RESULT_QUOTE_EMPTY', 'evidence[0].quote'],
    ['wrong-quote', 'NO_RESULT_QUOTE_NOT_IN_SOURCE', 'evidence[0].quote'],
    ['no-evidence', 'NO_RESULT_EVIDENCE_REQUIRED', 'evidence'],
    ['blocking-issue', 'NO_RESULT_BLOCKING_ISSUE', 'issues[0].code'],
    ['no-binding', 'NO_RESULT_FIELD_BINDING_REQUIRED', 'sourceBinding'],
    ['empty-finding', 'NO_RESULT_FINDING_EVIDENCE_REQUIRED', 'sourceBinding.findingEvidence'],
    ['duplicate-only', 'NO_RESULT_PRIMARY_SOURCE_REQUIRED', 'sourceBinding.findingEvidence[0].sourceRole'],
    ['wrong-role', 'NO_RESULT_SOURCE_ROLE_NOT_ALLOWED', 'sourceBinding.findingEvidence[0].sourceSpanId'],
    ['not-blank', 'NO_RESULT_FIELD_REASON_NOT_BLANK', 'value.reason'],
    ['raw-text', 'NO_RESULT_FIELD_RAW_TEXT_PRESENT', 'value.rawText'],
    ['wrong-name', 'NO_RESULT_FIELD_NAME_MISMATCH', 'originalName'],
    ['partial-quote', 'NO_RESULT_FIELD_QUOTE_NOT_EXACT', 'evidence[0].quote'],
    ['missing-general', 'NO_RESULT_PRIMARY_NOT_IN_EVIDENCE', 'sourceBinding.findingEvidence[0].sourceSpanId'],
    ['multiple-headings', 'NO_RESULT_FIELD_SINGLE_SOURCE_REQUIRED', 'sourceBinding.findingEvidence'],
    ['extra-duplicate', 'NO_RESULT_FIELD_SINGLE_SOURCE_REQUIRED', 'sourceBinding.findingEvidence']
  ] as const)('%s准确指出未满足的字段约束且不复制正文', (kind, reasonCode, fieldPath) => {
    const f = fixture();
    const addOther = () => {
      f.reading.sourceExcerpts.push({ localKey: 'e_other', pageSourceSpanId: 'synthetic-page', quote: '不可复制的合成附带正文', role: 'date', clarity: 'clear' });
      return { sourceSpanId: 'e_other', quote: null };
    };
    if (kind === 'missing-source') f.reading.sourceExcerpts = [];
    if (kind === 'ambiguous-source') f.reading.sourceExcerpts.push({ ...f.reading.sourceExcerpts[0]! });
    if (kind === 'uncertain-source') f.reading.sourceExcerpts[0]!.clarity = 'uncertain';
    if (kind === 'missing-page') f.reading.pageReadings = [];
    if (kind === 'ambiguous-page') f.reading.pageReadings.push({ ...f.reading.pageReadings[0]! });
    if (kind === 'partial-page') f.reading.pageReadings[0]!.status = 'partial';
    if (kind === 'empty-quote') f.candidate.evidence[0]!.quote = '  ';
    if (kind === 'wrong-quote') f.candidate.evidence[0]!.quote = '不可复制的合成候选引用';
    if (kind === 'no-evidence') f.candidate.evidence = [];
    if (kind === 'blocking-issue') f.candidate.issues = [{ code: 'blocking_source_uncertain', message: '不可复制的合成问题描述' }];
    if (kind === 'no-binding') delete f.candidate.sourceBinding;
    if (kind === 'empty-finding') f.candidate.sourceBinding!.findingEvidence = [];
    if (kind === 'duplicate-only') f.candidate.sourceBinding!.findingEvidence[0]!.sourceRole = 'duplicate_source';
    if (kind === 'wrong-role') f.reading.sourceExcerpts[0]!.role = 'date';
    if (kind === 'not-blank') f.candidate.value = { kind: 'unknown', rawText: null, reason: 'no_data' };
    if (kind === 'raw-text') f.candidate.value = { kind: 'unknown', rawText: '不可复制的合成原值', reason: 'original_blank' };
    if (kind === 'wrong-name') f.candidate.originalName = '不可复制的合成项目名';
    if (kind === 'partial-quote') f.candidate.evidence = [{ sourceSpanId: 'e_blank', quote: '空白字段' }];
    if (kind === 'missing-general') f.candidate.evidence = [addOther()];
    if (kind === 'multiple-headings') {
      const other = addOther();
      f.reading.sourceExcerpts[1]!.role = 'heading';
      f.candidate.evidence.push(other);
      f.candidate.sourceBinding!.findingEvidence.push(other);
    }
    if (kind === 'extra-duplicate') f.candidate.sourceBinding!.findingEvidence.push({ ...f.candidate.evidence[0]!, sourceRole: 'duplicate_source' });
    const before = structuredClone(f);
    const diagnostics = diagnoseDirectOriginalNoResult(f.candidate, f.reading);
    expect(diagnostics).toContainEqual(expect.objectContaining({ targetId: 'c_blank', reasonCode, fieldPath, constraint: expect.any(String) }));
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain('不可复制的');
    expect(f).toEqual(before);
  });

  it('诊断保留实际来源角色和页状态，而不把未读页说成缺少数值', () => {
    const f = fixture(); f.reading.pageReadings[0]!.status = 'no_medical_content';
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toContainEqual(expect.objectContaining({
      targetId: 'c_blank', reasonCode: 'NO_RESULT_PAGE_NOT_READ', fieldPath: 'sourceBinding.findingEvidence[0].sourceSpanId',
      sourceSpanId: 'e_blank', actualRole: 'heading', actualPageStatus: 'no_medical_content'
    }));
    expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual([]);
  });

  it('字段标签末尾标点不匹配精准反馈原名，模型补全后才沿用原精确门槛通过', () => {
    const f = fixture(); f.reading.sourceExcerpts[0]!.quote = '合成空白字段：';
    expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual([]);
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toContainEqual(expect.objectContaining({
      reasonCode: 'NO_RESULT_FIELD_NAME_MISMATCH', fieldPath: 'originalName', sourceSpanId: 'e_blank',
      actualRole: 'heading', allowedRoles: ['heading'], constraint: expect.stringContaining('完整标签及空白位置')
    }));
    f.candidate.originalName = '合成空白字段：';
    expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual(['e_blank']);
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toEqual([]);
  });
});

describe('原件页职责与空白字段来源一致', () => {
  const addAncillary = (f: ReturnType<typeof fixture>, role: DirectOriginalReadingResult['sourceExcerpts'][number]['role'], location: 'evidence' | 'headingEvidence' | 'conditions') => {
    const ref = { sourceSpanId: 'e_cover', quote: '合成附带来源' };
    f.reading.pageReadings.push({ sourceSpanId: 'cover-page', status: 'no_medical_content' });
    f.reading.sourceExcerpts.push({ localKey: 'e_cover', pageSourceSpanId: 'cover-page', quote: '合成附带来源', role, clarity: 'clear' });
    if (location === 'evidence') f.candidate.evidence.push(ref);
    if (location === 'headingEvidence') f.candidate.sourceBinding!.headingEvidence.push(ref);
    if (location === 'conditions') f.candidate.clinicalContext = { version: 1, status: 'complete', conditions: [ref] };
    return ref;
  };

  it.each(['heading', 'finding', 'instruction'] as const)('%s主依据即使清晰也始终要求read页', (role) => {
    const f = fixture(); f.reading.sourceExcerpts[0]!.role = role;
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(true);
    f.reading.pageReadings[0]!.status = 'no_medical_content';
    expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual([]);
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toContainEqual(expect.objectContaining({
      reasonCode: 'NO_RESULT_PAGE_NOT_READ', fieldPath: 'sourceBinding.findingEvidence[0].sourceSpanId',
      sourceSpanId: 'e_blank', actualRole: role, actualPageStatus: 'no_medical_content'
    }));
  });

  it.each(['date', 'identity', 'heading', 'context'] as const)('%s附带来源可位于明确无医疗结果的封面，主空白字段仍须read', (role) => {
    for (const location of ['evidence', 'headingEvidence', 'conditions'] as const) {
      const f = fixture(); addAncillary(f, role, location);
      const before = structuredClone(f);
      expect(directOriginalNoResultSourceKeys(f.candidate, f.reading)).toEqual(['e_blank']);
      expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toEqual([]);
      expect(f).toEqual(before);
    }
  });

  it.each(['finding', 'instruction'] as const)('%s即便放在附带引用中也不能借无医疗内容页证明结果', (role) => {
    const f = fixture(); addAncillary(f, role, 'headingEvidence');
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(false);
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toContainEqual(expect.objectContaining({
      reasonCode: 'NO_RESULT_PAGE_NOT_READ', fieldPath: 'sourceBinding.headingEvidence[0].sourceSpanId',
      sourceSpanId: 'e_cover', actualRole: role, actualPageStatus: 'no_medical_content'
    }));
  });

  it.each(['partial', 'unreadable', 'missing-page', 'ambiguous-page', 'uncertain', 'wrong-quote'] as const)('%s附带来源依然拒绝，且给出具体来源路径', (kind) => {
    const f = fixture(); const ref = addAncillary(f, 'date', 'conditions');
    if (kind === 'partial' || kind === 'unreadable') f.reading.pageReadings[1]!.status = kind;
    if (kind === 'missing-page') f.reading.pageReadings.pop();
    if (kind === 'ambiguous-page') f.reading.pageReadings.push({ ...f.reading.pageReadings[1]! });
    if (kind === 'uncertain') f.reading.sourceExcerpts[1]!.clarity = 'uncertain';
    if (kind === 'wrong-quote') ref.quote = '另一处的合成内容';
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(false);
    expect(diagnoseDirectOriginalNoResult(f.candidate, f.reading)).toContainEqual(expect.objectContaining({
      fieldPath: `clinicalContext.conditions[0].${kind === 'wrong-quote' ? 'quote' : 'sourceSpanId'}`, sourceSpanId: 'e_cover'
    }));
  });
});
