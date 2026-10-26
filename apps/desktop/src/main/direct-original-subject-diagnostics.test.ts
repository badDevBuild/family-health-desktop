import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult } from '@contracts';
import { diagnoseDirectOriginalSubjectSources } from './direct-original-subject-diagnostics.js';

function fixture(): DirectOriginalReadingResult {
  return { schemaVersion: 1, documentId: 'synthetic-document',
    pageReadings: [{ sourceSpanId: 'page-cover', status: 'no_medical_content' }],
    sourceExcerpts: [{ localKey: 'e_identity', pageSourceSpanId: 'page-cover',
      quote: '合成患者身份来源甲', role: 'identity', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: 'synthetic-document', coveredSourceSpanIds: ['page-cover'], candidates: [],
      subject: { confidence: 'explicit', reportedName: '合成患者甲', evidence: [{ sourceSpanId: 'e_identity', quote: null }] } } };
}

describe('原件主体来源的只读诊断', () => {
  it('有效主体无共享目标时不生成诊断，也不核对姓名文字来猜成员归属', () => {
    const reading = fixture();
    reading.extraction.subject.reportedName = '与摘录不同的合成名称';
    const before = structuredClone(reading);
    expect(diagnoseDirectOriginalSubjectSources(reading)).toEqual([]);
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set() })).toEqual([]);
    expect(reading).toEqual(before);
  });

  it.each(['finding', 'heading', 'date', 'instruction', 'context'] as const)('%s不能充当identity来源', (role) => {
    const reading = fixture(); reading.sourceExcerpts[0]!.role = role;
    expect(diagnoseDirectOriginalSubjectSources(reading)).toEqual([{ targetId: 'subject',
      reasonCode: 'SUBJECT_SOURCE_ROLE_NOT_ALLOWED', fieldPath: 'evidence[0].sourceSpanId',
      sourceSpanId: 'e_identity', actualRole: role, allowedRoles: ['identity'], constraint: expect.any(String) }]);
  });

  it.each([
    ['missing', 'SUBJECT_SOURCE_MISSING', 'evidence[0].sourceSpanId', null],
    ['ambiguous', 'SUBJECT_SOURCE_AMBIGUOUS', 'evidence[0].sourceSpanId', null],
    ['unclear', 'SUBJECT_SOURCE_NOT_CLEAR', 'evidence[0].sourceSpanId', 'identity'],
    ['source-empty', 'SUBJECT_SOURCE_QUOTE_EMPTY', 'evidence[0].sourceSpanId', 'identity'],
    ['reference-empty', 'SUBJECT_REFERENCE_QUOTE_EMPTY', 'evidence[0].quote', 'identity'],
    ['reference-other', 'SUBJECT_REFERENCE_NOT_IN_SOURCE', 'evidence[0].quote', 'identity']
  ] as const)('%s准确说明来源或引用约束而不泄露正文', (kind, reasonCode, fieldPath, actualRole) => {
    const reading = fixture();
    if (kind === 'missing') reading.sourceExcerpts = [];
    if (kind === 'ambiguous') reading.sourceExcerpts.push({ ...reading.sourceExcerpts[0]! });
    if (kind === 'unclear') reading.sourceExcerpts[0]!.clarity = 'uncertain';
    if (kind === 'source-empty') reading.sourceExcerpts[0]!.quote = '  ';
    if (kind === 'reference-empty') reading.extraction.subject.evidence[0]!.quote = '  ';
    if (kind === 'reference-other') reading.extraction.subject.evidence[0]!.quote = '不能回显的合成引用';
    const before = structuredClone(reading);
    const diagnostics = diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['e_identity']) });
    expect(diagnostics).toEqual([{ targetId: 'subject', reasonCode, fieldPath,
      sourceSpanId: 'e_identity', actualRole, allowedRoles: ['identity'], constraint: expect.any(String) }]);
    expect(JSON.stringify(diagnostics)).not.toContain('合成患者');
    expect(JSON.stringify(diagnostics)).not.toContain('不能回显的合成引用');
    expect(reading).toEqual(before);
  });

  it('explicit缺少姓名和证据时分别定位，不代填姓名', () => {
    const reading = fixture(); reading.extraction.subject.reportedName = null; reading.extraction.subject.evidence = [];
    expect(diagnoseDirectOriginalSubjectSources(reading)).toEqual([
      { targetId: 'subject', reasonCode: 'SUBJECT_REPORTED_NAME_REQUIRED', fieldPath: 'reportedName', constraint: expect.any(String) },
      { targetId: 'subject', reasonCode: 'SUBJECT_EVIDENCE_REQUIRED', fieldPath: 'evidence', constraint: expect.any(String) }
    ]);
    expect(reading.extraction.subject.reportedName).toBeNull();
  });

  it('uncertain允许保留原有姓名，只描述不确定状态，不要求编造或改写答案', () => {
    const reading = fixture(); reading.extraction.subject.confidence = 'uncertain';
    const before = structuredClone(reading);
    expect(diagnoseDirectOriginalSubjectSources(reading).map(({ reasonCode, fieldPath }) => ({ reasonCode, fieldPath }))).toEqual([
      { reasonCode: 'SUBJECT_IDENTITY_UNCERTAIN', fieldPath: 'confidence' }
    ]);
    expect(reading).toEqual(before);
    reading.extraction.subject.reportedName = null; reading.extraction.subject.evidence = [];
    expect(diagnoseDirectOriginalSubjectSources(reading)).toEqual([
      { targetId: 'subject', reasonCode: 'SUBJECT_IDENTITY_UNCERTAIN', fieldPath: 'confidence', constraint: expect.stringContaining('保留不确定状态') }
    ]);
  });

  it('absent不强制补主体，亦不因保护集合生成保留义务', () => {
    const reading = fixture(); reading.extraction.subject = { confidence: 'absent', reportedName: null, evidence: [] };
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['e_identity']) })).toEqual([]);
    reading.extraction.subject.evidence = [{ sourceSpanId: 'missing', quote: null }];
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['missing']) })).toEqual([]);
  });

  it.each([null, '患者身份', '合成 患者身份来源甲'])('有效引用%j被共享时输出保留义务而非失败', (quote) => {
    const reading = fixture(); reading.extraction.subject.evidence[0]!.quote = quote;
    const protectedSourceKeys = new Set(['e_identity']);
    const before = structuredClone(reading);
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys })).toEqual([
      { targetId: 'subject', reasonCode: 'SUBJECT_REFERENCE_OBLIGATION', fieldPath: 'evidence[0].sourceSpanId',
        sourceSpanId: 'e_identity', actualRole: 'identity', allowedRoles: ['identity'],
        constraint: expect.stringContaining('独立新增 identity 摘录并重绑 subject.evidence') }
    ]);
    expect(reading).toEqual(before);
    expect([...protectedSourceKeys]).toEqual(['e_identity']);
  });

  it('相同角色或姓名不表示共享，仅精确命中被保护localKey的引用才有义务', () => {
    const reading = fixture();
    reading.sourceExcerpts.push({ ...reading.sourceExcerpts[0]!, localKey: 'e_other' });
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['e_other']) })).toEqual([]);
    reading.extraction.subject.evidence.push({ sourceSpanId: 'e_other', quote: null });
    expect(diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['e_other']) })
      .map(({ fieldPath, sourceSpanId }) => ({ fieldPath, sourceSpanId }))).toEqual([
      { fieldPath: 'evidence[1].sourceSpanId', sourceSpanId: 'e_other' }
    ]);
  });

  it('多个引用逐项诊断且不因另一条有效identity或同名文字掩盖坏引用', () => {
    const reading = fixture();
    reading.sourceExcerpts.push({ ...reading.sourceExcerpts[0]!, localKey: 'e_finding', role: 'finding', clarity: 'uncertain' });
    reading.extraction.subject.evidence.push({ sourceSpanId: 'e_finding', quote: null }, { sourceSpanId: 'e_missing', quote: null });
    const diagnostics = diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys: new Set(['e_identity']) });
    expect(diagnostics.map(({ reasonCode, fieldPath }) => ({ reasonCode, fieldPath }))).toEqual([
      { reasonCode: 'SUBJECT_SOURCE_NOT_CLEAR', fieldPath: 'evidence[1].sourceSpanId' },
      { reasonCode: 'SUBJECT_SOURCE_ROLE_NOT_ALLOWED', fieldPath: 'evidence[1].sourceSpanId' },
      { reasonCode: 'SUBJECT_SOURCE_MISSING', fieldPath: 'evidence[2].sourceSpanId' }
    ]);
    expect(diagnostics.some(({ reasonCode }) => reasonCode === 'SUBJECT_REFERENCE_OBLIGATION')).toBe(false);
  });
});
