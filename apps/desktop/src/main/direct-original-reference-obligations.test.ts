import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult, ObservationCandidate, ReportMetadataCandidate } from '@contracts';
import { directOriginalReferenceObligations } from './direct-original-reference-obligations.js';
import { isDirectOriginalExplicitNoResult } from './direct-original-no-result.js';

type EvidenceRef = ObservationCandidate['evidence'][number];
const ref = (sourceSpanId: string): EvidenceRef & { quote: string } => ({ sourceSpanId, quote: '不可复制的合成引用正文' });
const protectedRefs = () => [ref('e_unselected'), ref('e_shared')];

it('行列、适用轴和互补分量均进入共享来源保留义务且只输出技术路径', () => {
  const f = fixture(); f.candidate.sourceBinding!.structuredSlot = { version: 1, kind: 'table_cell',
    contextEvidence: protectedRefs(), rowEvidence: protectedRefs(), columnEvidence: protectedRefs(),
    axes: [{ kind: 'frequency', evidence: protectedRefs() }], component: { kind: 'quantitative', evidence: protectedRefs() } };
  const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
  for (const path of ['contextEvidence[1]', 'rowEvidence[1]', 'columnEvidence[1]', 'axes[0].evidence[1]', 'component.evidence[1]']) {
    expect(obligations.some((item) => item.fieldPath === `sourceBinding.structuredSlot.${path}`)).toBe(true);
  }
  expect(JSON.stringify(obligations)).not.toContain('不可复制的合成');
});

function fixture() {
  const candidate: ObservationCandidate = { localKey: 'c_shared', originalName: '不可复制的合成项目名', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '987.654', decimal: '987.654', comparator: 'lt' }, unitRaw: '不可复制的合成单位',
    referenceRangeRaw: '不可复制的合成参考范围', reportedAbnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
    clinicalDate: null, evidence: protectedRefs(), sourceBinding: { headingEvidence: protectedRefs(), findingEvidence: protectedRefs() },
    clinicalContext: { version: 1, status: 'complete', conditions: protectedRefs() },
    issues: [{ code: 'synthetic_issue', message: '不可复制的合成问题描述' }] };
  const reading: DirectOriginalReadingResult = { schemaVersion: 1, documentId: 'synthetic-document',
    pageReadings: [{ sourceSpanId: 'page_authorized', status: 'read' }],
    sourceExcerpts: [
      { localKey: 'e_shared', pageSourceSpanId: 'page_authorized', quote: '不可复制的合成来源正文', role: 'finding', clarity: 'clear' },
      { localKey: 'e_date', pageSourceSpanId: 'page_authorized', quote: '不可复制的合成日期正文', role: 'date', clarity: 'clear' },
      { localKey: 'e_unselected', pageSourceSpanId: 'page_authorized', quote: '不可复制的非授权来源', role: 'context', clarity: 'clear' }
    ], extraction: { schemaVersion: 1, documentId: 'synthetic-document',
      subject: { reportedName: '不可复制的合成姓名', confidence: 'explicit', evidence: [ref('e_unselected')] },
      coveredSourceSpanIds: ['page_authorized'], candidates: [candidate] } };
  return { candidate, reading };
}

function metadata(): ReportMetadataCandidate {
  const field = () => ({ value: '不可复制的合成元数据', evidence: protectedRefs() });
  return { reportKind: field(), title: field(), organization: field(), campus: field(), department: field(), reportNumber: field(),
    encounterIdentifier: field(), sampleIdentifiers: [field(), field()], examItems: [field(), field()], primaryClinicalTimeIndex: 0,
    times: [{ value: '2026-01-02', precision: 'day', role: 'examined', evidence: protectedRefs() },
      { value: '2026-01', precision: 'month', role: 'report_issued', evidence: protectedRefs() }] };
}

describe('授权共享来源的全部引用者保留义务', () => {
  it('逐个保留 candidate 的相对字段路径及原数组下标，不按同一摘录去重', () => {
    const f = fixture();
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
    expect(obligations.map(({ targetId, fieldPath, sourceSpanId }) => ({ targetId, fieldPath, sourceSpanId }))).toEqual([
      { targetId: 'c_shared', fieldPath: 'evidence[1]', sourceSpanId: 'e_shared' },
      { targetId: 'c_shared', fieldPath: 'sourceBinding.findingEvidence[1]', sourceSpanId: 'e_shared' },
      { targetId: 'c_shared', fieldPath: 'sourceBinding.headingEvidence[1]', sourceSpanId: 'e_shared' },
      { targetId: 'c_shared', fieldPath: 'clinicalContext.conditions[1]', sourceSpanId: 'e_shared' }
    ]);
    expect(obligations.every((item) => item.reasonCode === 'DIRECT_ORIGINAL_REFERENCE_OBLIGATION' && item.actualRole === 'finding')).toBe(true);
    expect(obligations.every((item) => item.constraint.includes('不表示本字段已失败'))).toBe(true);
    expect(obligations[0]).not.toHaveProperty('allowedRoles');
    expect(obligations[1]!.allowedRoles).toEqual(['finding', 'instruction']);
    expect(obligations[2]!.allowedRoles).toEqual(['heading', 'context', 'finding', 'instruction']);
    expect(obligations[3]!.allowedRoles).toEqual(['finding', 'context', 'instruction', 'date']);
  });

  it('标题复用明确要求本候选同摘录唯一不重叠窄范围，而不是泛化角色许可', () => {
    const f = fixture();
    const heading = directOriginalReferenceObligations(f.reading, new Set(['e_shared']))
      .find((item) => item.fieldPath === 'sourceBinding.headingEvidence[1]')!;
    for (const requirement of ['本候选', '同摘录', '唯一', '不重叠', '非整块', '其他候选']) expect(heading.constraint).toContain(requirement);
  });

  it('同一摘录被多个候选和同一数组多次引用时，各职责均不遗漏', () => {
    const f = fixture(); f.candidate.evidence.push(ref('e_shared'));
    f.reading.extraction.candidates.push({ ...structuredClone(f.candidate), localKey: 'c_second' });
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
    expect(obligations).toHaveLength(10);
    for (const targetId of ['c_shared', 'c_second']) expect(obligations.filter((item) => item.targetId === targetId).map((item) => item.fieldPath))
      .toEqual(['evidence[1]', 'evidence[2]', 'sourceBinding.findingEvidence[1]', 'sourceBinding.headingEvidence[1]', 'clinicalContext.conditions[1]']);
  });

  it('多个授权来源分别保留实际角色，不扩展到未选择引用者或同页其他来源', () => {
    const f = fixture(); f.candidate.evidence.push(ref('e_date'));
    f.reading.extraction.candidates.push({ ...structuredClone(f.candidate), localKey: 'c_unrelated',
      evidence: [ref('e_unselected')], sourceBinding: undefined, clinicalContext: null });
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared', 'e_date', 'e_unused']));
    expect(obligations).toHaveLength(5);
    expect(new Set(obligations.map((item) => item.targetId))).toEqual(new Set(['c_shared']));
    expect(new Set(obligations.map((item) => item.sourceSpanId))).toEqual(new Set(['e_shared', 'e_date']));
    expect(obligations.find((item) => item.sourceSpanId === 'e_date')).toMatchObject({ fieldPath: 'evidence[2]', actualRole: 'date' });
  });

  it.each(['missing', 'ambiguous'] as const)('来源%s时 actualRole 保持 null，不推断角色或复制原话', (kind) => {
    const f = fixture();
    if (kind === 'missing') f.reading.sourceExcerpts = f.reading.sourceExcerpts.filter((item) => item.localKey !== 'e_shared');
    else f.reading.sourceExcerpts.push({ ...f.reading.sourceExcerpts[0]!, role: 'instruction' });
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
    expect(obligations).toHaveLength(4);
    expect(obligations.every((item) => item.actualRole === null)).toBe(true);
  });

  it('空集合、无引用匹配和空候选均不产生授权外义务', () => {
    const f = fixture();
    expect(directOriginalReferenceObligations(f.reading, new Set())).toEqual([]);
    expect(directOriginalReferenceObligations(f.reading, new Set(['not_referenced']))).toEqual([]);
    f.reading.extraction.candidates = [];
    expect(directOriginalReferenceObligations(f.reading, new Set(['e_shared']))).toEqual([]);
  });

  it('旧候选无 sourceBinding/clinicalContext 仍只记录实际 evidence 引用，不造新字段', () => {
    const f = fixture(); delete f.candidate.sourceBinding; delete f.candidate.clinicalContext;
    expect(directOriginalReferenceObligations(f.reading, new Set(['e_shared']))).toEqual([
      expect.objectContaining({ targetId: 'c_shared', fieldPath: 'evidence[1]', sourceSpanId: 'e_shared' })
    ]);
  });
});

describe('元数据引用的相对位置和日期职责', () => {
  it.each(['reportKind', 'title', 'organization', 'campus', 'department', 'reportNumber', 'encounterIdentifier'] as const)(
    '%s 的证据位置相对 metadata，不附带完整元数据或错误角色约束', (key) => {
      const f = fixture(); f.reading.extraction.candidates = [];
      const value = metadata(); f.reading.extraction.reportMetadata = { ...value,
        reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null,
        encounterIdentifier: null, sampleIdentifiers: [], examItems: [], times: [], [key]: value[key] };
      const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
      expect(obligations).toHaveLength(1);
      expect(obligations[0]).toMatchObject({ targetId: 'metadata', fieldPath: `${key}.evidence[1]`, sourceSpanId: 'e_shared', actualRole: 'finding' });
      expect(obligations[0]).not.toHaveProperty('allowedRoles');
    });

  it('数组元数据每个元素和每个时间均保留，不以相同引用折叠条目', () => {
    const f = fixture(); f.reading.extraction.candidates = []; f.reading.extraction.reportMetadata = metadata();
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
    expect(obligations).toHaveLength(13);
    expect(obligations.map((item) => item.fieldPath)).toEqual([
      'reportKind.evidence[1]', 'title.evidence[1]', 'organization.evidence[1]', 'campus.evidence[1]',
      'department.evidence[1]', 'reportNumber.evidence[1]', 'encounterIdentifier.evidence[1]',
      'sampleIdentifiers[0].evidence[1]', 'sampleIdentifiers[1].evidence[1]', 'examItems[0].evidence[1]', 'examItems[1].evidence[1]',
      'times[0].evidence[1]', 'times[1].evidence[1]'
    ]);
    const times = obligations.filter((item) => item.fieldPath.startsWith('times['));
    expect(times.every((item) => JSON.stringify(item.allowedRoles) === JSON.stringify(['date', 'finding', 'instruction']))).toBe(true);
    expect(times.every((item) => item.constraint.includes('日期角色') && item.constraint.includes('签发时间'))).toBe(true);
  });

  it('nullable 元数据和缺失可选数组不制造职责，也不把主要日期索引当来源引用', () => {
    const f = fixture(); f.reading.extraction.candidates = [];
    f.reading.extraction.reportMetadata = null;
    expect(directOriginalReferenceObligations(f.reading, new Set(['e_shared']))).toEqual([]);
    f.reading.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [], primaryClinicalTimeIndex: null };
    expect(directOriginalReferenceObligations(f.reading, new Set(['e_shared']))).toEqual([]);
  });
});

describe('明确空白职责沿用原来源规则', () => {
  it('合法同名 heading 空白的 findingEvidence 不被误导成只能 finding/instruction', () => {
    const f = fixture(); const primary = { sourceSpanId: 'e_shared', quote: null };
    f.candidate.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    f.candidate.originalName = '合成明确空白字段'; f.candidate.evidence = [primary];
    f.candidate.sourceBinding = { headingEvidence: [], findingEvidence: [primary] };
    f.candidate.clinicalContext = null;
    Object.assign(f.reading.sourceExcerpts[0]!, { role: 'heading', quote: '合成明确空白字段' });
    expect(isDirectOriginalExplicitNoResult(f.candidate, f.reading)).toBe(true);
    const finding = directOriginalReferenceObligations(f.reading, new Set(['e_shared']))
      .find((item) => item.fieldPath === 'sourceBinding.findingEvidence[0]')!;
    expect(finding.allowedRoles).toEqual(['finding', 'instruction', 'heading']);
    expect(finding.actualRole).toBe('heading');
    for (const requirement of ['唯一', '同名完整字段标签', 'rawText=null', '不能用目录']) expect(finding.constraint).toContain(requirement);
  });

  it.each(['not_performed', 'no_data', 'unreadable'] as const)('%s 不把 heading 单独升级为合法主要结果来源', (reason) => {
    const f = fixture(); f.candidate.value = { kind: 'unknown', rawText: null, reason };
    const finding = directOriginalReferenceObligations(f.reading, new Set(['e_shared']))
      .find((item) => item.fieldPath === 'sourceBinding.findingEvidence[1]')!;
    expect(finding.allowedRoles).toEqual(['finding', 'instruction']);
  });

  it('有 rawText 的 original_blank 不通过职责列表放宽 heading 规则', () => {
    const f = fixture(); f.candidate.value = { kind: 'unknown', rawText: '不可复制的合成未定内容', reason: 'original_blank' };
    const finding = directOriginalReferenceObligations(f.reading, new Set(['e_shared']))
      .find((item) => item.fieldPath === 'sourceBinding.findingEvidence[1]')!;
    expect(finding.allowedRoles).toEqual(['finding', 'instruction']);
  });

  it.each(['original_blank', 'not_performed', 'no_data'] as const)('%s 附带栏目/条件不套用确认事实的角色门禁', (reason) => {
    const f = fixture(); f.candidate.value = { kind: 'unknown', rawText: null, reason };
    f.reading.sourceExcerpts[0]!.role = 'identity';
    const obligations = directOriginalReferenceObligations(f.reading, new Set(['e_shared']));
    for (const path of ['sourceBinding.headingEvidence[1]', 'clinicalContext.conditions[1]']) {
      const ancillary = obligations.find((item) => item.fieldPath === path)!;
      expect(ancillary.actualRole).toBe('identity');
      expect(ancillary).not.toHaveProperty('allowedRoles');
      expect(ancillary.constraint).toContain('附带');
    }
  });
});

describe('义务记录不复制正文且不修改输入', () => {
  it('只含结构和固定约束，不带原件姓名/原值/单位/元数据正文，来源和候选不被改写', () => {
    const f = fixture(); f.reading.extraction.reportMetadata = metadata(); const keys = new Set(['e_shared']);
    const before = structuredClone(f.reading);
    const obligations = directOriginalReferenceObligations(f.reading, keys);
    expect(f.reading).toEqual(before); expect([...keys]).toEqual(['e_shared']);
    const encoded = JSON.stringify(obligations);
    for (const secret of ['不可复制的', '987.654', '2026-01-02', '2026-01']) expect(encoded).not.toContain(secret);
    for (const obligation of obligations) expect(Object.keys(obligation).sort()).toEqual([
      ...(obligation.allowedRoles ? ['allowedRoles'] : []), 'actualRole', 'constraint', 'fieldPath', 'reasonCode', 'sourceSpanId', 'targetId'
    ].sort());
    obligations[0]!.constraint = '仅修改测试返回值';
    expect(f.reading).toEqual(before);
  });
});
