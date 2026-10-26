import { describe, expect, it } from 'vitest';
import { stableHash } from '@core';
import type { MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';
import { inspectAssessmentReviewBoundary, type ActionDependencyRebinding, type AssessmentReviewBoundaryReason } from './assessment-review-boundary.js';
import { buildAssessmentEvidenceResolutions } from './assessment-evidence-resolution.js';

// 全部为脱敏合成节点，不读取家庭档案、数据库或模型。
function candidate(): MemberAssessmentCandidateV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: '0'.repeat(64), mode: 'full',
    requestedSystemIds: ['digestive', 'endocrine_metabolic'],
    overview: { id: 'overview', headline: '既有检查结果', summary: '需要结合当前情况理解。',
      claimIds: ['claim:synthetic', 'claim:other'], actionIds: ['action:synthetic'], limitations: ['缺少当前资料。'] },
    systems: [{ id: 'system:digestive', systemId: 'digestive', status: 'monitor', headline: '消化检查结果',
      summary: '保留原报告中的信息。', claimIds: ['claim:synthetic', 'claim:other'], actionIds: ['action:synthetic'], limitations: [] }],
    claims: [{ id: 'claim:synthetic', topicKey: 'synthetic-topic', systemIds: ['digestive'],
      kind: 'diagnostic_assessment', title: '既有报告的诊断记录',
      text: '2024年2月3日原报告诊断为胃炎；该次指标为 4.2 mmol/L。',
      diseaseName: '胃炎', diagnosticStatus: 'documented', temporalStatus: 'historical',
      evidenceIds: ['source:first', 'source:second'], counterEvidenceIds: ['source:counter'], trendIds: ['trend:first', 'trend:second'],
      knowledgeBasis: 'catalog', knowledgeSourceIds: ['knowledge:first', 'knowledge:second'], criteriaBasis: null,
      rationale: '这些信息属于同次既有检查。', materialUncertainty: '尚不清楚当前情况。', consequenceLevel: 'important' }],
    actions: [{ id: 'action:synthetic', dedupeKey: 'synthetic-followup', systemIds: ['digestive'],
      claimIds: ['claim:synthetic', 'claim:other'], kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '保持规律饮食', why: '结合原有资料关注日常感受。', firstStep: '选择容易坚持的规律用餐时间。',
      timing: null, timingBasis: 'none', reviewPlan: null, caution: '如有不适请咨询医生。', urgency: 'routine',
      evidenceIds: ['source:first', 'source:second'], knowledgeSourceIds: ['knowledge:first'] }],
    questions: [{ id: 'question:synthetic', question: '这次检查时是否有不适？', whyItMatters: '有助于理解既有结果。',
      relatedClaimIds: ['claim:synthetic', 'claim:other'], evidenceIds: ['source:first', 'source:second'] }],
    knowledgeSources: []
  };
}

function catalog(date = '2024-02-03'): MemberEvidenceRef[] {
  return ['source:first', 'source:second', 'source:counter'].map((id) => ({
    id, kind: 'source_span', documentId: 'synthetic-document', sourceSpanId: `span:${id}`, observationId: null,
    eventId: null, knowledgeId: null, label: '合成来源', locator: date, quote: `${date} 合成资料，仅供测试。`
  }));
}

function inspect(original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3, targetId = 'claim:synthetic') {
  return inspectAssessmentReviewBoundary(original, reviewed, targetId, catalog(), '2026-10-16');
}

function expectRejected(original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3,
  code: AssessmentReviewBoundaryReason, targetId = 'claim:synthetic') {
  const result = inspect(original, reviewed, targetId);
  expect(result.preserved).toBe(false);
  expect(result.reasonCodes).toContain(code);
}

describe('精确数值展示与有原文证明的窄来源修正', () => {
  it.each(['2019至2020年', '2019和2020年', '2019、2020年', '2019年以及2020年', '2019年'])(
    '原有来源支持的叙事年份 %s 不当作新增测量值', (years) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'interpretation', diseaseName: null, diagnosticStatus: null,
      text: '2018至2020年结果在各自参考范围内。', rationale: '仅按各次范围比较。' });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = `${years}结果在各自参考范围内。`;
    const sources: MemberEvidenceRef[] = ['source:first', 'source:second'].map((id, index) => ({
      id, kind: 'observation', observationId: id, documentId: id, sourceSpanId: id, eventId: null, knowledgeId: null,
      label: '合成来源', locator: `${2019 + index}-03-04 第1页`, quote: '合成项目结果。' }));
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').preserved).toBe(true);
  });
  it.each(['2031年结果在范围内。', '数值为2019 mmol/L。', '编号A2019和2020年。', '第2019年。',
    '数值1.2019和2020年。', '2019年13月4日结果。', '数值2E+2019和2020年。'])(
    '没有来源或不是独立日期的数字不因叙事年份豁免：%s', (text) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'interpretation', diseaseName: null, diagnosticStatus: null, text: '2020年结果在范围内。' });
    const reviewed = structuredClone(original); reviewed.claims[0]!.text = text;
    expect(inspect(original, reviewed).preserved).toBe(false);
  });
  it('检查前用药背景不完整的说明可随有依据的解释修正，实际操作仍保护', () => {
    const original = candidate();
    original.claims[0]!.rationale = '检查前用药条件不完整；本次结果需结合条件理解。';
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.rationale = '本次结果需结合条件理解；检查前用药条件不完整。';
    expect(inspect(original, reviewed).preserved).toBe(true);
    reviewed.claims[0]!.rationale = '检查前用药条件不完整，建议现在服用合成药物。';
    expect(inspect(original, reviewed).reasonCodes).toContain('medication_instruction_changed');
  });
  it.each([['1.0', '1'], ['1.2300', '1.23'], ['-1.00', '-1'], ['2.00E+02', '2E+02']])(
    '相同来源、单位和比较符允许小数尾零 %s → %s，不改正式事实', (beforeValue, afterValue) => {
      const original = candidate();
      Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        criteriaBasis: null, text: `本次测量为 <${beforeValue} mmol/L。` });
      const reviewed = structuredClone(original);
      reviewed.claims[0]!.text = `本次测量为 <${afterValue} mmol/L。`;
      expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
      expect(original.claims[0]!.text).toContain(beforeValue);
    });

  it.each(['本次测量为 <1.01 mmol/L。', '本次测量为 ≤1 mmol/L。', '本次测量为 <1 mg/L。',
    '本次测量为 <-1 mmol/L。', '本次测量为 <1000 umol/L。', '本次测量为 <1E+02 mmol/L。'])(
    '格式宽容不允许改变精度、比较符、单位、符号或换算：%s', (text) => {
      const original = candidate();
      Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        criteriaBasis: null, text: '本次测量为 <1.00 mmol/L。' });
      const reviewed = structuredClone(original); reviewed.claims[0]!.text = text;
      expect(inspect(original, reviewed).preserved).toBe(false);
    });

  function proofFixture(kind: 'reference' | 'missing') {
    const original = candidate();
    const sources = catalog();
    sources[0]!.quote = '检测方式：合成方法，保留限定';
    sources.push({ ...sources[0]!, id: 'source:alias' });
    const reviewed = structuredClone(original);
    if (kind === 'reference') reviewed.claims[0]!.evidenceIds = ['source:alias', 'source:second'];
    else {
      original.claims[0]!.materialUncertainty = '检测方式未提供';
      reviewed.claims[0]!.materialUncertainty = sources[0]!.quote;
    }
    const proof = kind === 'reference'
      ? { kind: 'same_fact_reference' as const, fromEvidenceId: 'source:first', toEvidenceId: 'source:alias',
        sourceQuote: sources[0]!.quote! }
      : { kind: 'missing_information_resolved' as const, evidenceId: 'source:first',
        uncertaintyText: original.claims[0]!.materialUncertainty!, subject: '检测方式', sourceQuote: sources[0]!.quote! };
    const review = { schemaVersion: 1 as const, personId: original.personId, inputSignature: original.inputSignature,
      results: [{ targetId: original.claims[0]!.id, verdict: 'replace' as const, reason: '合成证明',
        replacement: { nodeType: 'claim' as const, value: reviewed.claims[0]! }, evidenceResolutionProofs: [proof] }] };
    return { original, reviewed, sources, review };
  }
  function verify(f: ReturnType<typeof proofFixture>, supplied = f.sources) {
    const grants = buildAssessmentEvidenceResolutions(f.original, f.reviewed, f.review,
      ['claim:synthetic'], supplied, f.sources);
    return inspectAssessmentReviewBoundary(f.original, f.reviewed, 'claim:synthetic', f.sources, '2026-10-16',
      [], [], [], grants, f.review.results.filter((result) => result.evidenceResolutionProofs.length > 0).map((result) => result.targetId));
  }

  it('同次明确核实、同一唯一位置的来源别名可补绑，默认仍不允许', () => {
    const f = proofFixture('reference');
    expect(inspectAssessmentReviewBoundary(f.original, f.reviewed, 'claim:synthetic', f.sources, '2026-10-16').reasonCodes)
      .toContain('support_expanded');
    expect(verify(f)).toEqual({ preserved: true, reasonCodes: [] });
  });
  it.each(['other_document', 'other_span', 'other_event', 'other_observation', 'counter', 'changed_text',
    'duplicate_source', 'unknown_source', 'not_supplied', 'stale_input', 'reason_only', 'duplicate_proof'] as const)(
    '%s不能借证明扩大依据或临床内容', (mutation) => {
      const f = proofFixture('reference'), alias = f.sources.at(-1)!;
      if (mutation === 'other_document') alias.documentId = 'other-document';
      if (mutation === 'other_span') alias.sourceSpanId = 'other-span';
      if (mutation === 'other_event') alias.eventId = 'other-event';
      if (mutation === 'other_observation') alias.observationId = 'other-observation';
      if (mutation === 'counter') f.original.claims[0]!.counterEvidenceIds.push(alias.id);
      if (mutation === 'changed_text') f.reviewed.claims[0]!.text += '另一临床结论。';
      if (mutation === 'duplicate_source') f.sources.push({ ...alias });
      if (mutation === 'unknown_source') f.sources.pop();
      if (mutation === 'stale_input') f.review.inputSignature = '9'.repeat(64);
      if (mutation === 'reason_only') f.review.results[0]!.evidenceResolutionProofs = [];
      if (mutation === 'duplicate_proof') f.review.results[0]!.evidenceResolutionProofs.push(f.review.results[0]!.evidenceResolutionProofs[0]!);
      expect(verify(f, mutation === 'not_supplied' ? f.sources.slice(0, -1) : f.sources).preserved).toBe(false);
    });

  it('纯缺资料断言只换成完整栏目原话，不判定该值明确、不授予置空', () => {
    const f = proofFixture('missing');
    expect(verify(f)).toEqual({ preserved: true, reasonCodes: [] });
    expect(f.reviewed.claims[0]!.materialUncertainty).toBe('检测方式：合成方法，保留限定');
    expect(f.reviewed.claims[0]!.rationale).toBe(f.original.claims[0]!.rationale);
  });
  it.each(['实际方法', '未说明', '无', '未见记录', '未知', '不确定', '', '尚未散瞳'])(
    '字段值“%s”只逐字保留，不根据非空或词语判断可以清空限制', (value) => {
      const f = proofFixture('missing');
      const proof = f.review.results[0]!.evidenceResolutionProofs[0]!;
      if (proof.kind !== 'missing_information_resolved') throw new Error('fixture');
      f.sources[0]!.quote = proof.sourceQuote = `检测方式：${value}`;
      f.reviewed.claims[0]!.materialUncertainty = proof.sourceQuote;
      expect(verify(f)).toEqual({ preserved: true, reasonCodes: [] });
      f.reviewed.claims[0]!.materialUncertainty = null;
      expect(verify(f).reasonCodes).toEqual(expect.arrayContaining(['uncertainty_removed', 'evidence_resolution_unproven']));
    });
  it.each(['同位素13C方法', '方法X13', '方法 27'])(
    '已锁定栏目原话中的方法数字“%s”不误当新增测量值', (method) => {
      const f = proofFixture('missing');
      const proof = f.review.results[0]!.evidenceResolutionProofs[0]!;
      if (proof.kind !== 'missing_information_resolved') throw new Error('fixture');
      f.sources[0]!.quote = proof.sourceQuote = `检测方式：${method}`;
      f.reviewed.claims[0]!.materialUncertainty = proof.sourceQuote;
      expect(verify(f)).toEqual({ preserved: true, reasonCodes: [] });
      // 同一真实来源有数字，也不能借栏目证明把测量值添到正文或解释。
      f.reviewed.claims[0]!.text += '另一测量为 27 mmol/L。';
      expect(verify(f).reasonCodes).toEqual(expect.arrayContaining(['evidence_resolution_unproven', 'numeric_fact_added']));
    });
  it('其他位置的相同数字不属于本目标已冻结的栏目来源', () => {
    const f = proofFixture('missing');
    const proof = f.review.results[0]!.evidenceResolutionProofs[0]!;
    if (proof.kind !== 'missing_information_resolved') throw new Error('fixture');
    const quote = '检测方式：方法 27';
    f.sources.push({ ...f.sources[0]!, id: 'source:elsewhere', sourceSpanId: 'another-position', quote });
    proof.evidenceId = 'source:elsewhere';
    proof.sourceQuote = quote;
    f.reviewed.claims[0]!.materialUncertainty = quote;
    expect(verify(f).reasonCodes).toEqual(expect.arrayContaining(['evidence_resolution_unproven', 'numeric_fact_added']));
  });
  it('栏目证明不豁免source_fact正文的原数值顺序或精确值', () => {
    const f = proofFixture('missing');
    for (const claim of [f.original.claims[0]!, f.reviewed.claims[0]!]) {
      Object.assign(claim, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null, criteriaBasis: null });
    }
    f.reviewed.claims[0]!.text = f.original.claims[0]!.text.replace('4.2', '4.3');
    expect(verify(f).reasonCodes).toEqual(expect.arrayContaining(['evidence_resolution_unproven', 'source_fact_numeric_changed']));
  });
  it('原话含实际药物操作时仍不能借栏目数值豁免放宽用药门禁', () => {
    const f = proofFixture('missing');
    const proof = f.review.results[0]!.evidenceResolutionProofs[0]!;
    if (proof.kind !== 'missing_information_resolved') throw new Error('fixture');
    f.sources[0]!.quote = proof.sourceQuote = '检测方式：请现在加量至3片';
    f.reviewed.claims[0]!.materialUncertainty = proof.sourceQuote;
    expect(verify(f).reasonCodes).toContain('medication_instruction_changed');
  });
  it.each(['partial_quote', 'invented_quote', 'remove_condition', 'compound_uncertainty',
    'true_limitation', 'changed_scope', 'not_supplied', 'duplicate_quote', 'wrong_person'] as const)(
    '%s不能借原文证明改写范围或限制', (mutation) => {
      const f = proofFixture('missing');
      const proof = f.review.results[0]!.evidenceResolutionProofs[0]!;
      if (proof.kind !== 'missing_information_resolved') throw new Error('fixture');
      if (mutation === 'partial_quote') proof.sourceQuote = '检测方式：合成方法';
      if (mutation === 'invented_quote') proof.sourceQuote = '检测方式：另一方法';
      if (mutation === 'remove_condition') f.reviewed.claims[0]!.materialUncertainty = '检测方式：合成方法';
      if (mutation === 'compound_uncertainty') f.original.claims[0]!.materialUncertainty = proof.uncertaintyText = '检测方式未提供且当前症状未知';
      if (mutation === 'true_limitation') f.original.claims[0]!.materialUncertainty = proof.uncertaintyText = '本次未散瞳';
      if (mutation === 'changed_scope') f.reviewed.claims[0]!.temporalStatus = 'current';
      if (mutation === 'duplicate_quote') f.sources[0]!.quote += `\n${proof.sourceQuote}`;
      if (mutation === 'wrong_person') f.review.personId = 'another-person';
      expect(verify(f, mutation === 'not_supplied' ? f.sources.slice(1) : f.sources).reasonCodes).toContain('evidence_resolution_unproven');
    });
});

describe('同次原文证明只修正解释中的来源背景', () => {
  function fixture() {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'interpretation', diseaseName: null, diagnosticStatus: null,
      materialUncertainty: '方法未提供；检查前用药条件不完整。',
      changeAssessment: { direction: 'uncertain', basis: 'insufficient', summary: '尚不能比较。',
        reason: '方法未提供；检查前用药条件不完整。', currentEvidenceIds: ['source:first'], previousEvidenceIds: [] } });
    const reviewed = structuredClone(original);
    const quote = '核素-17呼气法';
    reviewed.claims[0]!.materialUncertainty = `${quote}；检查前用药条件不完整。`;
    reviewed.claims[0]!.changeAssessment!.reason = `${quote}；检查前用药条件不完整。`;
    const source: MemberEvidenceRef = { id: 'source:first', kind: 'observation', observationId: 'obs:synthetic',
      documentId: 'doc:synthetic', sourceSpanId: 'span:synthetic', eventId: null, knowledgeId: null,
      label: '合成检查', locator: '第1页', quote };
    const review = { schemaVersion: 1 as const, personId: original.personId, inputSignature: original.inputSignature,
      results: [{ targetId: 'claim:synthetic', verdict: 'replace' as const, reason: '来源已明确方法，其他未知保留。',
        replacement: { nodeType: 'claim' as const, value: reviewed.claims[0]! },
        evidenceResolutionProofs: (['materialUncertainty', 'changeAssessment.reason'] as const).map((field) => ({
          kind: 'source_context_text' as const, contextKind: 'method' as const, evidenceId: source.id, sourceQuote: quote, field })) }] };
    return { original, reviewed, sources: [source], review };
  }
  function inspectProof(f: ReturnType<typeof fixture>, supplied = f.sources) {
    const grants = buildAssessmentEvidenceResolutions(f.original, f.reviewed, f.review, ['claim:synthetic'], supplied, f.sources);
    return inspectAssessmentReviewBoundary(f.original, f.reviewed, 'claim:synthetic', f.sources, '2026-10-16',
      [], [], [], grants, ['claim:synthetic']);
  }
  it('带数字的方法名可逐字补到声明的解释字段，不改正式结果或其他临床字段', () => {
    const f = fixture();
    expect(inspect(f.original, f.reviewed).reasonCodes).toContain('numeric_fact_added');
    expect(inspectProof(f)).toEqual({ preserved: true, reasonCodes: [] });
  });
  it.each(['not_supplied', 'counter', 'duplicate_source', 'duplicate_quote', 'invented_quote', 'changed_value',
    'changed_direction', 'other_field_number', 'source_fact', 'wrong_input', 'medication'] as const)(
    '%s 不取得解释背景的额外权限', (mutation) => {
    const f = fixture();
    if (mutation === 'counter') f.original.claims[0]!.counterEvidenceIds.push('source:first');
    if (mutation === 'duplicate_source') f.sources.push({ ...f.sources[0]! });
    if (mutation === 'duplicate_quote') f.sources[0]!.quote += f.sources[0]!.quote!;
    if (mutation === 'invented_quote') f.sources[0]!.quote = '另一方法';
    if (mutation === 'changed_value') f.reviewed.claims[0]!.text += '数值8 mmol/L。';
    if (mutation === 'changed_direction') f.reviewed.claims[0]!.changeAssessment!.direction = 'improving';
    if (mutation === 'other_field_number') f.reviewed.claims[0]!.rationale += '数值17。';
    if (mutation === 'source_fact') f.original.claims[0]!.kind = f.reviewed.claims[0]!.kind = 'source_fact';
    if (mutation === 'wrong_input') f.review.inputSignature = '9'.repeat(64);
    if (mutation === 'medication') f.reviewed.claims[0]!.materialUncertainty += '请现在开始服用合成药物。';
    expect(inspectProof(f, mutation === 'not_supplied' ? [] : f.sources).preserved).toBe(false);
  });
});

describe('主 P04 已提供前提的窄依赖补齐', () => {
  it('复核可纠正本人既有用药状态的转述，不把它当作给药指令', () => {
    const original = candidate();
    original.claims[0]!.materialUncertainty = '仍缺少症状背景；本人自述不规律服用合成药物，不能反推历史情况。';
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.materialUncertainty = '仍缺少症状背景；本人自述没有定期服用合成药物，不能反推历史情况。';
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['本人自述需要服用合成药物。', '本人自述请服用合成药物。', '本人自述以后服用合成药物。',
    '本人自述如果不适就服用合成药物。', '本人自述没有服用合成药物，请开始服用合成药物。',
    '本人自述每天服用合成药物。', '本人自述服用合成药物2片。', '本人自述不要服用合成药物。', '请按本人自述服用合成药物。'])(
    '自述前缀不豁免决策、未来安排、条件、剂量或独立指令：%s', text => {
      const original = candidate(); original.claims[0]!.materialUncertainty = '本人自述没有定期服用合成药物。';
      const reviewed = structuredClone(original); reviewed.claims[0]!.materialUncertainty = text;
      expectRejected(original, reviewed, 'medication_instruction_changed');
    });

  it('同一段中的解释可收窄，独立用药操作句的完整条件仍保留', () => {
    const original = candidate();
    original.claims[0]!.text = '原记录是历史安排。这个旧安排不宜作为当前自行加量的依据：合成外部说明缺乏支持。仍需了解当前情况。';
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = '原记录是历史安排。这个旧安排不宜作为当前自行加量的依据。仍需了解当前情况。';
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
    for (const text of ['原记录是历史安排。仍需了解当前情况。',
      '原记录是历史安排。这个旧安排宜作为当前自行加量的依据。仍需了解当前情况。',
      '原记录是历史安排。这个旧安排不宜作为当前自行减量的依据。仍需了解当前情况。']) {
      reviewed.claims[0]!.text = text;
      expectRejected(original, reviewed, 'medication_instruction_changed');
    }
  });

  it.each([
    ['如果有不适：不要自行停药。', '如果没有不适：不要自行停药。'],
    ['如果有不适。不要自行停药。', '如果没有不适。不要自行停药。'],
    ['合成说明。不要自行停药：停药前需要联系原医生。', '合成说明。不要自行停药。'],
    ['不要自行停药。', '不要自行停药；请自行减量。']
  ])('分离独立说明仍不能改条件、后置操作或增加操作：%s', (before, after) => {
    const original = candidate(); original.actions[0]!.caution = before;
    const reviewed = structuredClone(original); reviewed.actions[0]!.caution = after;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each([
    ['不要自行增加剂量。以上仅适用于当前已用方案。', '不要自行增加剂量。'],
    ['不要自行增加剂量。以上仅适用于当前已用方案。', '不要自行增加剂量。以上适用于所有人。'],
    ['按医嘱使用。该安排仅适用于复诊后确认方案的人。', '按医嘱使用。'],
    ['按医嘱使用。复诊后才适用。', '按医嘱使用。复诊前才适用。'],
    ['按医嘱使用。成人适用，儿童不适用。', '按医嘱使用。'],
    ['按医嘱使用。成人适用，儿童不适用。', '按医嘱使用。成人和儿童均适用。'],
    ['按医嘱使用。这是原医生的安排。儿童不适用。', '按医嘱使用。'],
    ['按医嘱使用。这是原医生的安排。儿童除外。', '按医嘱使用。这是原医生的安排。']
  ])('后置操作范围不能删除或改写：%s', (before, after) => {
    const original = candidate(); original.actions[0]!.caution = before;
    const reviewed = structuredClone(original); reviewed.actions[0]!.caution = after;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it('后置条件完整保留时仍可删除独立外部解释句', () => {
    const original = candidate();
    original.actions[0]!.caution = '不要自行增加剂量。以上仅适用于当前已用方案。外部材料给出合成解释。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = '不要自行增加剂量。以上仅适用于当前已用方案。';
    expect(inspect(original, reviewed, 'action:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['不要自行加量。', '已提供检查方法。不要自行加量。'])(
    '普通缺失背景可独立删除或纠正，而不改变操作条件：%s', (after) => {
      const original = candidate(); original.actions[0]!.caution = '检查方法尚未提供。不要自行加量。';
      const reviewed = structuredClone(original); reviewed.actions[0]!.caution = after;
      expect(inspect(original, reviewed, 'action:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
    }
  );

  it('范围跨解释句保持不变时，独立背景仍可修正', () => {
    const original = candidate(); original.actions[0]!.caution = '按医嘱使用。检查方法尚未提供。儿童不适用。';
    const reviewed = structuredClone(original); reviewed.actions[0]!.caution = '按医嘱使用。已提供检查方法。儿童不适用。';
    expect(inspect(original, reviewed, 'action:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it('缺失背景说明的收窄不等于新增给药动作，真实操作仍保护', () => {
    const original = candidate();
    original.systems[0]!.summary = '检查方式及检测前用药条件未提供。';
    const reviewed = structuredClone(original);
    reviewed.systems[0]!.summary = '检测前用药条件未提供。';
    expect(inspect(original, reviewed, 'system:digestive')).toEqual({ preserved: true, reasonCodes: [] });
    for (const summary of ['检测前用药条件未提供，请停药。', '请用药条件未提供。',
      '用药每次2片的信息未提供。', '用药前应加量的条件未提供。']) {
      reviewed.systems[0]!.summary = summary;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'system:digestive');
    }
  });

  it.each(['注射液', '注射剂', '口服液', '口服剂'])(
    '剂型名%s不是执行动词，独立测量解释可修正，历史与否定推论逐字保留', (form) => {
      const original = candidate();
      original.claims[0]!.text = `合成标本的单项记录偏低不等于全身状况异常，既往治疗使用合成制品${form}也不代表目前需要长期补充。`;
      const reviewed = structuredClone(original);
      reviewed.claims[0]!.text = `单项记录偏低不等于全身状况异常，既往治疗使用合成制品${form}也不代表目前需要长期补充。`;
      reviewed.claims[0]!.rationale = '单项记录只能在其原检查范围内理解。';
      expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
    }
  );

  it.each([
    '单项记录偏低不等于整体异常，既往治疗有合成注射液记录，不代表目前需要长期补充。',
    '单项记录偏低不等于整体异常。既往治疗有合成注射液记录。这不代表目前需要长期补充。',
    '单项记录偏低不等于整体异常。治疗期间，合成注射液仅用于当时安排。此记录不表示目前需要长期补充。'
  ])('独立测量说明可删除，名词剂型前后的历史和否定范围仍保持：%s', (text) => {
    const original = candidate(); original.claims[0]!.text = text;
    const reviewed = structuredClone(original); reviewed.claims[0]!.text = text.replace(/^单项记录偏低不等于整体异常[，。]/u, '');
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each([
    ['既往治疗使用合成注射液也不代表目前需要长期补充。', '目前治疗使用合成注射液也不代表目前需要长期补充。'],
    ['既往治疗使用合成注射液也不代表目前需要长期补充。', '既往治疗使用合成注射液代表目前需要长期补充。'],
    ['既往治疗使用合成注射液也不代表目前需要长期补充。', '既往治疗使用合成注射液。'],
    ['既往治疗使用合成注射液也不代表目前需要长期补充。', ''],
    ['既往治疗使用合成注射液也不代表目前需要长期补充。', '既往治疗使用合成注射液，也不代表目前需要长期补充，需再次注射合成药。'],
    ['曾有甲注射液记录，不代表需要长期补充。', '甲注射液记录，不代表需要长期补充。'],
    ['曾有甲注射液记录，不代表需要长期补充。', '曾有甲注射液记录。'],
    ['曾有甲注射液记录，不代表需要长期补充。', '不代表需要长期补充。'],
    ['曾有甲注射液记录，并非当前需要长期补充。', '曾有甲注射液记录，当前需要长期补充。'],
    ['曾有甲注射液记录，不建议自行长期补充。', '曾有甲注射液记录，建议自行长期补充。'],
    ['既往治疗中，甲注射液有相关记录。', '甲注射液有相关记录。'],
    ['曾有甲注射液记录。上述不代表需要长期补充。', '曾有甲注射液记录。上述代表需要长期补充。'],
    ['治疗期间，曾有甲注射液记录，不代表需要长期补充。', '治疗后，曾有甲注射液记录，不代表需要长期补充。'],
    ['曾有甲注射液记录，剂量为3 mg，不代表目前需要长期补充。', '曾有甲注射液记录，不代表目前需要长期补充。'],
    ['曾有甲注射液记录，剂量为3 mg，不代表目前需要长期补充。', '曾有甲注射液记录，剂量为4 mg，不代表目前需要长期补充。'],
    ['既往有合成口服液记录，不代表需要长期补充。', '请使用合成口服液，不代表需要长期补充。'],
    ['既往有合成注射剂记录，不代表需要长期补充。', '既往有合成注射剂记录，可以按时注射。'],
    ['如果原医生另有安排，既往有合成注射液记录。', '既往有合成注射液记录。']
  ])('剂型名词分类不能删除或改写历史、否定、条件、剂量或新增执行：%s', (before, after) => {
    const original = candidate(); original.claims[0]!.text = `独立合成结果需按原记录理解。${before}`;
    const reviewed = structuredClone(original); reviewed.claims[0]!.text = `独立合成结果需按原记录理解。${after}`;
    expectRejected(original, reviewed, 'medication_instruction_changed');
  });

  it('同句有真实执行动词时仍保护完整操作，剂型名词不能使逗号前件解除绑定', () => {
    const original = candidate();
    original.actions[0]!.caution = '有不适时，按医嘱注射合成药，并保留甲注射液记录。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = '无不适时，按医嘱注射合成药，并保留甲注射液记录。';
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });
  it.each(['注射剂量', '口服剂量', '注射液体', '口服液体'])(
    '%s仍是动作或剂量结构，不借内部剂型字形解除完整前件', (operation) => {
      const original = candidate();
      original.actions[0]!.caution = `单项合成结果不等于整体异常，${operation}应由原医生决定。`;
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = `${operation}应由原医生决定。`;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
    }
  );
  function fixture() {
    const original = candidate();
    original.actions[0]!.claimIds = [];
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.claimIds = ['claim:synthetic'];
    const sources = catalog();
    const permission: ActionDependencyRebinding = { targetId: 'action:synthetic', personId: original.personId,
      inputSignature: original.inputSignature, originalActionHash: stableHash(original.actions[0]),
      claims: [{ id: original.claims[0]!.id, inputHash: stableHash(original.claims[0]), reviewedHash: stableHash(original.claims[0]),
        sourceHashes: sources.map((source) => ({ id: source.id, hash: stableHash(source) })) }] };
    return { original, reviewed, sources, permission };
  }

  it('默认仍拒绝补依赖；应用冻结权限只接受同批未变前提和原行动，可收窄旧知识', () => {
    const f = fixture();
    expect(inspectAssessmentReviewBoundary(f.original, f.reviewed, 'action:synthetic', f.sources, '2026-10-16').reasonCodes)
      .toContain('support_expanded');
    f.reviewed.actions[0]!.knowledgeSourceIds = [];
    expect(inspectAssessmentReviewBoundary(f.original, f.reviewed, 'action:synthetic', f.sources, '2026-10-16', [], [],
      [f.permission])).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['claim_text', 'claim_evidence', 'claim_counter_evidence', 'claim_removed', 'claim_duplicate', 'cross_type_id',
    'source_changed', 'source_missing', 'source_duplicate', 'permission_person', 'permission_signature', 'permission_action',
    'permission_duplicate', 'action_text', 'action_evidence', 'action_kind', 'action_timing', 'action_instruction',
    'drop_original_claim', 'unknown_claim'] as const)('%s 不能借冻结权限扩张复核范围', (change) => {
    const f = fixture();
    if (change === 'claim_text') f.reviewed.claims[0]!.text += '新增正文。';
    if (change === 'claim_evidence') f.reviewed.claims[0]!.evidenceIds = ['source:first'];
    if (change === 'claim_counter_evidence') f.reviewed.claims[0]!.counterEvidenceIds = [];
    if (change === 'claim_removed') f.reviewed.claims = [];
    if (change === 'claim_duplicate') f.reviewed.claims.push(structuredClone(f.reviewed.claims[0]!));
    if (change === 'cross_type_id') f.reviewed.questions[0]!.id = 'claim:synthetic';
    if (change === 'source_changed') f.sources[0]!.quote = '同 ID 的另一份资料。';
    if (change === 'source_missing') f.sources.pop();
    if (change === 'source_duplicate') f.sources.push(structuredClone(f.sources[0]!));
    if (change === 'permission_person') f.permission.personId = 'another-person';
    if (change === 'permission_signature') f.permission.inputSignature = '1'.repeat(64);
    if (change === 'permission_action') f.permission.originalActionHash = '1'.repeat(64);
    if (change === 'action_text') f.reviewed.actions[0]!.why += '新的原因。';
    if (change === 'action_evidence') f.reviewed.actions[0]!.evidenceIds = ['source:first'];
    if (change === 'action_kind') f.reviewed.actions[0]!.kind = 'treatment_discussion';
    if (change === 'action_timing') f.reviewed.actions[0]!.timing = '下次复诊';
    if (change === 'action_instruction') f.reviewed.actions[0]!.sourceInstructionObservationId = 'new-instruction';
    if (change === 'unknown_claim') f.reviewed.actions[0]!.claimIds.push('claim:unknown');
    if (change === 'drop_original_claim') {
      f.original.actions[0]!.claimIds = ['claim:other'];
      f.permission.originalActionHash = stableHash(f.original.actions[0]);
    }
    const result = inspectAssessmentReviewBoundary(f.original, f.reviewed, 'action:synthetic', f.sources, '2026-10-16', [], [],
      change === 'permission_duplicate' ? [f.permission, f.permission] : [f.permission]);
    expect(result.preserved).toBe(false);
    expect(result.reasonCodes).toContain('support_expanded');
  });
});

describe('inspectAssessmentReviewBoundary 原范围内单调收窄', () => {
  it('原本无个人前提的一般习惯可以接受同次P04，但不能借此清掉个人依据', () => {
    const original = candidate();
    Object.assign(original.actions[0]!, { claimIds: [], evidenceIds: [], knowledgeSourceIds: [], lifestyleBasis: 'general' });
    const reviewed = structuredClone(original);
    expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(true);
    reviewed.actions[0]!.lifestyleBasis = 'personalized';
    expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(false);
  });

  it('同次可更正已提供知识目录归属，未知来源仍不可增加', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.knowledgeSourceIds = ['knowledge:other-supplied'];
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', catalog(), '2026-10-16',
      ['knowledge:other-supplied']).preserved).toBe(true);
    expect(inspect(original, reviewed).reasonCodes).toContain('knowledge_scope_expanded');
  });

  it('可以说明原反证已明示的完整日期，但不能新增数值或医疗期限', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    const sources = catalog().map((source) => source.id === 'source:counter'
      ? { ...source, quote: '2021-07-09 合成旧记录。' } : source);
    reviewed.claims[0]!.rationale = '2021年7月9日的旧结果不能说明这次检查。';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').preserved).toBe(true);
    reviewed.claims[0]!.rationale += '应在13周后复查。';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('numeric_fact_added');
  });

  it('删除反证后不能把该来源的结果数值改写成只由原支持证明的新事实', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { kind: 'source_fact', diagnosticStatus: null, diseaseName: null,
      criteriaBasis: null, counterEvidenceIds: [], text: '该次指标为 5.2 mmol/L。' });
    const sources = catalog().map((source) => source.id === 'source:counter'
      ? { ...source, quote: '2021-07-09 指标为5.2 mmol/L。' } : source);
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('numeric_fact_added');
  });

  it('系统可清楚说明原已引用的同一紧急行动，但不能借用未关联的紧急行动', () => {
    const original = candidate();
    original.actions[0]!.urgency = 'emergency';
    const reviewed = structuredClone(original);
    reviewed.systems[0]!.summary = '若目前有相关急症表现，立即前往急诊。';
    expect(inspect(original, reviewed, 'system:digestive').preserved).toBe(true);
    original.systems[0]!.actionIds = [];
    reviewed.systems[0]!.actionIds = [];
    expect(inspect(original, reviewed, 'system:digestive').reasonCodes).toContain('urgency_increased');
  });
  it('原节点不变或集合仅换顺序可以保留', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.requestedSystemIds.reverse();
    reviewed.claims[0]!.evidenceIds.reverse();
    reviewed.claims[0]!.trendIds.reverse();
    reviewed.claims[0]!.knowledgeSourceIds.reverse();
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['source_fact', 'interpretation'] as const)('documented 可在同来源内降为 %s 并删除不适用依据', (kind) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { kind, diseaseName: null, diagnosticStatus: null,
      title: '既有检查结果', text: '2024-02-03 原报告记录该次指标为 4.2 mmol/L。',
      evidenceIds: ['source:first'], counterEvidenceIds: [], trendIds: [],
      knowledgeBasis: 'model_general', knowledgeSourceIds: [], consequenceLevel: 'routine' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['likely', 'possible', 'undetermined'] as const)('同病名确定性可降低到 %s', (diagnosticStatus) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.diagnosticStatus = diagnosticStatus;
    expect(inspect(original, reviewed).preserved).toBe(true);
  });

  it('标准依据仅在一并降低 criteria_met 结论时可整项撤除', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { diagnosticStatus: 'criteria_met', criteriaBasis: {
      criteriaSetId: 'criteria:synthetic', sourceId: 'knowledge:first', applicability: '合成适用条件',
      requirements: [{ criterionId: 'criterion:first', status: 'met', evidenceIds: ['source:first'] }]
    } });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { diagnosticStatus: 'possible', criteriaBasis: null });
    expect(inspect(original, reviewed).preserved).toBe(true);
    reviewed.claims[0]!.diagnosticStatus = 'criteria_met';
    expectRejected(original, reviewed, 'criteria_changed');
    reviewed.claims[0]!.criteriaBasis = { ...original.claims[0]!.criteriaBasis!, requirements: [] };
    expectRejected(original, reviewed, 'criteria_changed');
  });

  it.each(['action:synthetic', 'question:synthetic', 'overview', 'system:digestive'])('%s 可删减原有依赖并保留独立支持', (targetId) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.claimIds = [];
    reviewed.actions[0]!.evidenceIds = ['source:first'];
    reviewed.actions[0]!.knowledgeSourceIds = [];
    reviewed.questions[0]!.relatedClaimIds = [];
    reviewed.questions[0]!.evidenceIds = ['source:first'];
    reviewed.overview.claimIds = ['claim:synthetic'];
    reviewed.overview.actionIds = [];
    reviewed.systems[0]!.claimIds = ['claim:synthetic'];
    reviewed.systems[0]!.actionIds = [];
    expect(inspect(original, reviewed, targetId).preserved).toBe(true);
  });

  it('来源事实的完整中文日期可改成 ISO 日期', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = original.claims[0]!.text.replace('2024年2月3日', '2024-02-03');
    expect(inspect(original, reviewed).preserved).toBe(true);
  });

  it.each(['FT4', 'HbA1c', 'T1a', 'IL-6'])('同一保留个人来源中的完整标识 %s 可补全名称，不把标识数字当检验结果', (identifier) => {
    const original = candidate();
    original.questions[0]!.question = '该次记录是否已有后续资料？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = `该次 ${identifier} 记录是否已有后续资料？`;
    const sources = catalog().map((source) => source.id === 'source:first'
      ? { ...source, quote: `合成原记录 ${identifier}，其余信息不变。` } : source);
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'question:synthetic', sources, '2026-10-16'))
      .toEqual({ preserved: true, reasonCodes: [] });
  });

  it('来源事实补全原有项目名内的标识，不改变原结果数值及顺序', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024年2月3日游离甲状腺素结果为 4.2 mmol/L。' });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = '2024-02-03 游离甲状腺素（FT4）结果为 4.2 mmol/L。';
    const sources = catalog().map((source) => ({ ...source, quote: '2024-02-03 游离甲状腺素（FT4）结果为 4.2 mmol/L。' }));
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').preserved).toBe(true);
    reviewed.claims[0]!.text = '2024-02-03 游离甲状腺素（FT4）结果为 4.3 mmol/L。';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('source_fact_numeric_changed');
  });

  it.each(['missing', 'counter_only', 'removed', 'new_reference', 'knowledge', 'ambiguous', 'partial'] as const)(
    '没有同一保留个人来源支持时，%s 的带数字标识不能混作名称放行', (scope) => {
      const original = candidate();
      const reviewed = structuredClone(original);
      reviewed.questions[0]!.question = '这次 FT4 检查是否已有后续资料？';
      const sources = catalog();
      if (scope === 'counter_only') sources.find((source) => source.id === 'source:counter')!.quote = 'FT4 合成原记录。';
      if (scope === 'removed') {
        sources[0]!.quote = 'FT4 合成原记录。';
        reviewed.questions[0]!.evidenceIds = ['source:second'];
      }
      if (scope === 'new_reference') {
        sources.push({ ...sources[0]!, id: 'source:new', quote: 'FT4 合成原记录。' });
        reviewed.questions[0]!.evidenceIds.push('source:new');
      }
      if (scope === 'knowledge') Object.assign(sources[0]!, { kind: 'knowledge', knowledgeId: 'knowledge:synthetic', quote: 'FT4 合成知识。' });
      if (scope === 'ambiguous') sources.push({ ...sources[0]!, quote: 'FT4 合成原记录。' });
      if (scope === 'partial') sources[0]!.quote = 'FT40 不能证明另一个标识。';
      expect(inspectAssessmentReviewBoundary(original, reviewed, 'question:synthetic', sources, '2026-10-16').reasonCodes)
        .toContain('numeric_fact_added');
    });

  it('既有标识不依赖重复来源仍可保留，但不能把FT3偷换成同页另一项FT4', () => {
    const original = candidate();
    original.questions[0]!.question = '该次 FT3 是否已有后续记录？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = '该次 FT3 检查是否已有后续资料？';
    expect(inspect(original, reviewed, 'question:synthetic').preserved).toBe(true);
    reviewed.questions[0]!.question = '该次 FT4 检查是否已有后续资料？';
    const sources = catalog().map((source) => ({ ...source, quote: '同页包含 FT3 和 FT4。' }));
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'question:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('numeric_fact_added');
  });

  it.each([
    ['4.2 mmol/l', '4.2 mmol/L'], ['12 μmol/L', '12 umol/l'], ['12 µmol/l', '12 μmol/L'],
    ['5 mIU/l', '5 miu/L'], ['7 mmHg', '7 mmhg'], ['9 mcg', '9 μg'],
    ['<2.00E＋02 IU/mL', '<2.00e+02 iu/ml'], ['≤4.2 mmol/L', '<=4.2 mmol/l']
  ])('确定等价的数字书写 %s → %s 不产生新事实', (before, after) => {
    const original = candidate();
    original.questions[0]!.question = `该次 ${before} 是否有后续资料？`;
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = `该次 ${after} 是否有后续资料？`;
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each([
    ['<2.00E+02 IU/mL', '>2.00E+02 IU/mL'], ['<2.00E+02 IU/mL', '2.00E+02 IU/mL'],
    ['<2.00E+02 IU/mL', '<2.00E+03 IU/mL'], ['2.00E-02 IU/mL', '2.00E+02 IU/mL'],
    ['12 μmol/L', '12 mmol/L'], ['5 mIU/L', '5 MIU/L'], ['4.2 mmol/L', '4.2 mg/dL'],
    ['27 cm/s', '27 cm'], ['5 IU/mL', '5 IU/L'], ['-3 mm', '3 mm'], ['3个月后', '3天后']
  ])('比较符、指数、量级、完整单位或期限变化 %s → %s 仍拦截', (before, after) => {
    const original = candidate();
    original.questions[0]!.question = `该次 ${before} 是否有后续资料？`;
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = `该次 ${after} 是否有后续资料？`;
    expectRejected(original, reviewed, 'numeric_fact_added', 'question:synthetic');
  });

  it('不能借名称补全同时从原来源复制原候选没有的结果或医疗期限', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    const sources = catalog().map((source) => ({ ...source, quote: 'FT4 为12 pmol/L；3个月后复查。' }));
    reviewed.questions[0]!.question = 'FT4 为12 pmol/L，是否已在3个月后复查？';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'question:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('numeric_fact_added');
  });

  it('不能借新增标识隐藏数值或补充剂剂量', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = '是否已服用合成剂量D1000？';
    expectRejected(original, reviewed, 'numeric_fact_added', 'question:synthetic');
    reviewed.actions[0]!.firstStep = '每日补充维生素D3 1000 IU。';
    expectRejected(original, reviewed, 'supplement_dose_introduced', 'action:synthetic');
  });

  it('历史或当前状态可谨慎收窄为时间不确定', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.temporalStatus = 'uncertain';
    expect(inspect(original, reviewed).preserved).toBe(true);
  });

  it('原支持资料全部明确为分析当日时，允许 historical 改为 current', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.temporalStatus = 'current';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', catalog('2026-10-16'), '2026-10-16').preserved).toBe(true);
  });

  it.each(['personId', 'inputSignature', 'mode', 'requestedSystemIds'] as const)('不能改变候选 %s 范围', (field) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    if (field === 'personId') reviewed.personId = 'another-synthetic-person';
    if (field === 'inputSignature') reviewed.inputSignature = '1'.repeat(64);
    if (field === 'mode') reviewed.mode = 'partition';
    if (field === 'requestedSystemIds') reviewed.requestedSystemIds = ['digestive'];
    expectRejected(original, reviewed, 'candidate_scope_changed');
  });

  it('不能换 ID、复用歧义 ID 或换节点类型', () => {
    const original = candidate();
    const renamed = structuredClone(original);
    renamed.claims[0]!.id = 'claim:renamed';
    expectRejected(original, renamed, 'target_missing');
    const duplicate = structuredClone(original);
    duplicate.questions[0]!.id = 'claim:synthetic';
    expectRejected(original, duplicate, 'target_ambiguous');
    const retyped = structuredClone(original);
    retyped.claims = [];
    retyped.questions[0]!.id = 'claim:synthetic';
    expectRejected(original, retyped, 'target_type_changed');
  });

  it.each(['topic', 'system', 'disease', 'certainty', 'consequence', 'uncertainty'] as const)('降级不能同时改变 %s', (change) => {
    const original = candidate();
    original.claims[0]!.diagnosticStatus = 'possible';
    const reviewed = structuredClone(original);
    const claim = reviewed.claims[0]!;
    const codes: Record<typeof change, AssessmentReviewBoundaryReason> = {
      topic: 'identity_changed', system: 'system_scope_changed', disease: 'disease_changed',
      certainty: 'diagnostic_certainty_increased', consequence: 'consequence_increased', uncertainty: 'uncertainty_removed'
    };
    if (change === 'topic') claim.topicKey = 'new-topic';
    if (change === 'system') claim.systemIds = ['endocrine_metabolic'];
    if (change === 'disease') claim.diseaseName = '鼻炎';
    if (change === 'certainty') claim.diagnosticStatus = 'likely';
    if (change === 'consequence') claim.consequenceLevel = 'high';
    if (change === 'uncertainty') claim.materialUncertainty = null;
    expectRejected(original, reviewed, codes[change]);
  });

  it('documented 与 criteria_met 不能互换，也不能给 source_fact 新增诊断类型', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.diagnosticStatus = 'criteria_met';
    expectRejected(original, reviewed, 'diagnostic_certainty_increased');
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null });
    expectRejected(original, reviewed, 'claim_kind_expanded');
  });

  it('降低类型时必须同时清空诊断字段，不能只改标签', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.kind = 'interpretation';
    expectRejected(original, reviewed, 'diagnostic_fields_inconsistent');
  });

  it.each(['new_support', 'empty_support', 'promote_counter', 'new_counter', 'new_trend', 'new_knowledge'] as const)('不允许 %s', (change) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    const claim = reviewed.claims[0]!;
    const codes: Record<typeof change, AssessmentReviewBoundaryReason> = {
      new_support: 'support_expanded', empty_support: 'support_empty', promote_counter: 'counter_evidence_promoted',
      new_counter: 'counter_evidence_expanded', new_trend: 'trend_expanded', new_knowledge: 'knowledge_scope_expanded'
    };
    if (change === 'new_support') claim.evidenceIds.push('source:new');
    if (change === 'empty_support') claim.evidenceIds = [];
    if (change === 'promote_counter') { claim.evidenceIds.push('source:counter'); claim.counterEvidenceIds = []; }
    if (change === 'new_counter') claim.counterEvidenceIds.push('source:first');
    if (change === 'new_trend') claim.trendIds.push('trend:new');
    if (change === 'new_knowledge') claim.knowledgeSourceIds.push('knowledge:new');
    expectRejected(original, reviewed, codes[change]);
  });

  it.each(['text', 'rationale', 'materialUncertainty', 'title'] as const)('诊断降为事实也不能在 %s 引入新数字', (field) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null });
    reviewed.claims[0]![field] = `${reviewed.claims[0]![field] ?? ''} 另一个结果为 8.6 mmol/L。`;
    expectRejected(original, reviewed, 'numeric_fact_added');
  });

  it.each(['date', 'unit', 'relative_time'] as const)('原有数字不能授权新的 %s 事实', (change) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    if (change === 'date') reviewed.claims[0]!.text = original.claims[0]!.text.replace('2024年2月3日', '2024年3月2日');
    if (change === 'unit') reviewed.claims[0]!.text = original.claims[0]!.text.replace('mmol/L', 'mg/dL');
    if (change === 'relative_time') reviewed.claims[0]!.rationale += ' 下周必须复查。';
    expectRejected(original, reviewed, change === 'relative_time' ? 'time_fact_added'
      : change === 'date' ? 'date_scope_or_precision_changed' : 'numeric_fact_added');
  });

  it('来源事实删除日期仍拦截，但不误称为改变检验数值', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = '原报告记录该次指标为 4.2 mmol/L。';
    const result = inspect(original, reviewed);
    expect(result).toEqual({ preserved: false, reasonCodes: ['date_scope_or_precision_changed'] });
  });

  it.each([
    '相关日期尚未确认。', '具体日期无法确认。', '手术日期未确认。',
    '尚不能确认手术日期。', '无法可靠确定具体日期。', '检查时间目前无法核实。',
    '该次手术的日期尚未明确。', '具体日期不明。'
  ])('模型仅撤回全部日期并明确时间不确定时保留原事实：%s', (materialUncertainty) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024年2月3日手术检查记录结果为4.2 mmol/L；2024年2月8日病理记录大小为7 mm。',
      materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', materialUncertainty,
      text: '手术检查记录结果为4.2 mmol/L；病理记录大小为7 mm。' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['append', 'prepend', 'already_uncertain'] as const)('纯日期撤回仍逐字保留原不确定说明：%s', (position) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024-02-03手术记录病变大小为7 mm。',
      materialUncertainty: position === 'already_uncertain' ? '缺少当前症状；手术日期尚未确认。' : '缺少当前症状。' });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', text: '手术记录病变大小为7 mm。',
      materialUncertainty: position === 'append' ? '缺少当前症状。手术日期尚未确认。'
        : position === 'prepend' ? '手术日期尚未确认。缺少当前症状。' : original.claims[0]!.materialUncertainty });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each([
    ['2021-04-06签发的', ''], ['2021年4月6日签发的', ''], ['于2021-04-06签发的', ''],
    ['在2021-04-06所出具的', ''], ['签发于2021-04-06的', ''], ['审核于2021-04-06的', ''],
    ['2021-04-06打印的', ''], ['2021-04-06签署的', ''], ['2021-04-06发布的', ''],
    ['2021-04-06的', ''], ['2021-04-06签发的', '签发的'], ['2021-04-06所出具的', '所出具的'],
    ['2021年4月签发的', ''], ['2021-04出具的', ''], ['2021年审核的', '']
  ])('只撤回明确日期时间修饰语，保留医学正文：%s → %s', (prefix, retainedPrefix) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: `${prefix}标本病理记录：左侧局部大小<8 mm，未见所述改变；若出现不适需结合症状。`,
      materialUncertainty: '尚缺当前症状。' });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain',
      text: `${retainedPrefix}标本病理记录：左侧局部大小<8 mm，未见所述改变；若出现不适需结合症状。`,
      materialUncertainty: '尚缺当前症状。该病理报告的具体日期尚未确认。' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it('多个日期可各自仅撤回日期或完整元数据修饰语，原事件次序保持不变', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2021-04-06签发的病理记录：左侧标本<8 mm；2021-04-08手术记录：未见所述改变。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain',
      text: '病理记录：左侧标本<8 mm；手术记录：未见所述改变。', materialUncertainty: '具体日期无法确认。' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
    reviewed.claims[0]!.text = '病理记录：左侧标本<8 mm；2021年4月手术记录：未见所述改变。';
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([
    ['2022年5月12日检查记录：左侧局部<9 mm；2022年5月18日报告时期的病理记录：未见所述改变。',
      '2022年5月12日检查记录：左侧局部<9 mm；病理记录：未见所述改变。'],
    ['2022年5月12日报告时期的记录：左侧局部<9 mm；2022年5月18日病理记录：未见所述改变。',
      '记录：左侧局部<9 mm；2022年5月18日病理记录：未见所述改变。'],
    ['2022年报告时间的记录：左侧局部<9 mm；5月18日病理记录：未见所述改变。',
      '记录：左侧局部<9 mm；5月18日病理记录：未见所述改变。'],
    ['5月12日报告日期的记录：左侧局部<9 mm；2022年5月病理记录：未见所述改变。',
      '记录：左侧局部<9 mm；2022年5月病理记录：未见所述改变。']
  ])('各日期只能整段保留或撤回，不要求同时删除其他独立日期：%s', (text, afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text, materialUncertainty: '原件签发时点不能冒充采样时点。' });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: afterText, temporalStatus: 'uncertain',
      materialUncertainty: '原件签发时点不能冒充采样时点。相关日期尚未确认。' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each([
    '2022年5月检查记录：左侧局部<9 mm；2023年7月18日病理记录：未见所述改变。',
    '5月12日检查记录：左侧局部<9 mm；2023年7月18日病理记录：未见所述改变。',
    '2022年检查记录：左侧局部<9 mm；2023年7月18日病理记录：未见所述改变。',
    '2022年7月18日检查记录：左侧局部<9 mm；病理记录：未见所述改变。',
    '2023年5月12日检查记录：左侧局部<9 mm；病理记录：未见所述改变。',
    '2023年7月18日检查记录：左侧局部<9 mm；2022年5月12日病理记录：未见所述改变。',
    '2022年5月12日检查记录：左侧局部<9 mm；2022年5月12日病理记录：未见所述改变。',
    '2022年5月13日检查记录：左侧局部<9 mm；2023年7月18日病理记录：未见所述改变。',
    '检查记录：左侧局部<9 mm；2022年5月12日病理记录：未见所述改变。'
  ])('保留日期不授权降精度、片段重组、新增、重复、换序或改派角色：%s', (afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2022年5月12日检查记录：左侧局部<9 mm；2023年7月18日病理记录：未见所述改变。',
      materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: afterText, temporalStatus: 'uncertain', materialUncertainty: '相关日期尚未确认。' });
    expectRejected(original, reviewed, 'date_scope_or_precision_changed');
  });

  it('原有年份与月日不能通过删除中间元数据修饰语拼成新的完整日期', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2022年报告时期的5月12日检查记录：左侧局部<9 mm。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: '2022年5月12日检查记录：左侧局部<9 mm。',
      temporalStatus: 'uncertain', materialUncertainty: '相关日期尚未确认。' });
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each(['1月31日', '2月28日', '2月29日', '4月30日', '12月31日', '2024年2月29日']) (
    '有效日历日期%s可整段撤回，月日不会被误报为改变检验数值', (date) => {
      const original = candidate();
      Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        text: `${date}报告时期的左侧记录：局部<9 mm，未见所述改变。`, materialUncertainty: null });
      const reviewed = structuredClone(original);
      Object.assign(reviewed.claims[0]!, { text: '左侧记录：局部<9 mm，未见所述改变。',
        temporalStatus: 'uncertain', materialUncertainty: '相关日期尚未确认。' });
      expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
    }
  );

  it.each(['0月2日', '13月1日', '4月31日', '2月30日', '3月0日', '3月40日', '第3月4日', '第 3月4日',
    '3月4日2', '33月4日', '2023年2月29日', '2024年2月30日', '2024年13月2日', '2024年4月31日',
    '12024年2月3日', '第2024年2月3日', '2024年2月300日', '2024-02-03-04', '1.3月4日', '3月4日.5']) (
    '非法日期或序数时程%s不能通过内部年/月日匹配撤回数值', (date) => {
      const original = candidate();
      Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        text: `${date}记录：局部<9 mm。`, materialUncertainty: null });
      const reviewed = structuredClone(original);
      Object.assign(reviewed.claims[0]!, { text: '记录：局部<9 mm。', temporalStatus: 'uncertain',
        materialUncertainty: '相关日期尚未确认。' });
      expectRejected(original, reviewed, 'source_fact_numeric_changed');
    }
  );

  it.each([
    ['2023年2月29日', '2023年'], ['2024年13月2日', '13月2日'],
    ['2024年4月31日', '4月31日'], ['12024年2月3日', '2月3日']
  ])('非法长日期%s不能通过删除部分字符变成较短日期%s', (date, retained) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: `${date}记录：局部<9 mm。`, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: `${retained}记录：局部<9 mm。`, temporalStatus: 'uncertain',
      materialUncertainty: '相关日期尚未确认。' });
    expectRejected(original, reviewed, 'source_fact_numeric_changed');
  });

  it.each([
    ['1e-3月4日', '1e-'], ['1E+3月4日', '1E+'], ['1e−3月4日', '1e−'],
    ['A3月4日', 'A'], ['A-3月4日', 'A-'], ['A_3月4日', 'A_'], ['A--3月4日', 'A--'],
    ['A/3月4日', 'A/'], ['3月4日A', 'A'], ['3月4日_A', '_A'], ['3月4日-A', '-A'],
    ['A2024年2月3日', 'A'], ['2024年2月3日A', 'A'], ['1e-2024年2月3日', '1e-'],
    ['2022-05-12/2022年5月18日', '2022-05-12/']
  ])('ASCII标识或科学计数粘连%s不能借内部日期撤回数字：%s', (value, afterValue) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: `合成结果${value}记录。`, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: `合成结果${afterValue}记录。`, temporalStatus: 'uncertain',
      materialUncertainty: '相关日期尚未确认。' });
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([' ', '\n', '\t', '\u3000'])('日期与ASCII指标之间的原始分隔%s不能因忽略空白而误成标识粘连', (separator) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: `2022年5月12日${separator}LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。`, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。', temporalStatus: 'uncertain',
      materialUncertainty: '相关日期尚未确认。' });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it('新增加的有效中文月日仍是未授权日期，不能误报成新增检验数值', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = '3月4日的这次检查是否已有后续资料？';
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: false,
      reasonCodes: ['date_scope_or_precision_changed'] });
  });

  it.each([
    '右侧标本<9 mm，未见所述改变；若出现不适需观察。',
    '左侧标本>9 mm，未见所述改变；若出现不适需观察。',
    '左侧标本<8 mm，未见所述改变；若出现不适需观察。',
    '左侧标本<9 cm，未见所述改变；若出现不适需观察。',
    '左侧标本<9 mm，可见所述改变；若出现不适需观察。',
    '左侧标本<9 mm，未见所述改变；出现不适需观察。'
  ])('月日撤回仍逐字保护侧别、比较符、数值、单位、否定和条件：%s', (afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '3月4日报告时期的左侧标本<9 mm，未见所述改变；若出现不适需观察。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: afterText, temporalStatus: 'uncertain', materialUncertainty: '相关日期尚未确认。' });
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([
    ['3月4日手术时期的左侧记录。', '左侧记录。'],
    ['3月4日检查时期的左侧记录。', '左侧记录。'],
    ['3月4日术后时期的左侧记录。', '左侧记录。'],
    ['3月4日报告时期后的左侧记录。', '左侧记录。'],
    ['截至3月4日报告时期的左侧记录。', '左侧记录。'],
    ['并非3月4日报告时期的左侧记录。', '并非左侧记录。'],
    ['若3月4日报告时期的左侧记录可用。', '若左侧记录可用。'],
    ['3月4日报告时期的术后左侧记录。', '左侧记录。']
  ])('纯文档时期语法不授权删除临床时期、术后、时序、否定或条件：%s', (text, afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { text: afterText, temporalStatus: 'uncertain', materialUncertainty: '相关日期尚未确认。' });
    expectRejected(original, reviewed, 'date_scope_or_precision_changed');
  });

  it.each([
    '该病理报告的具体日期尚未确认。', '无法确认该病理报告的具体日期。',
    '这份报告的确切时间无法核实。', '该份病理报告的准确日期仍未明确。', '原报告日期未知。'
  ])('不确定说明解析指代、结构助词和日期精度修饰，不创造事件：%s', (materialUncertainty) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2021-04-06签发的标本病理记录：未见所述改变。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', text: '标本病理记录：未见所述改变。', materialUncertainty });
    expect(inspect(original, reviewed)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it('报告类型只从本主张实际、唯一的支持来源标题取得锚点', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2021-04-06签发的标本结果：未见所述改变。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', text: '标本结果：未见所述改变。',
      materialUncertainty: '该病理报告的具体日期尚未确认。' });
    const unrelated = { ...catalog()[0]!, id: 'source:unrelated', label: '合成病理报告' };
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', [...catalog(), unrelated], '2026-10-16').preserved).toBe(false);
    const supported = catalog().map((source) => source.id === 'source:first' ? { ...source, label: '合成病理报告' } : source);
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', supported, '2026-10-16').preserved).toBe(true);
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', [...supported, supported[0]!], '2026-10-16').preserved).toBe(false);
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', supported.filter((source) => source.id !== 'source:second'), '2026-10-16').preserved).toBe(false);
    const knowledge = supported.map((source) => ({ ...source, kind: 'knowledge' as const, knowledgeId: 'knowledge:first', documentId: null }));
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', knowledge, '2026-10-16').preserved).toBe(false);
  });

  it.each([
    ['截至2021-04-06未见改变。', '未见改变。'], ['2021-04-06前未见改变。', '未见改变。'],
    ['2021-04-06后未见改变。', '未见改变。'], ['2021-04-06签发后未见改变。', '未见改变。'],
    ['2021-04-06手术后的病理记录。', '病理记录。'], ['2021-04-06采样的病理记录。', '病理记录。'],
    ['2021-04-06服药后的记录。', '记录。'], ['2021-04-06检查的病理记录。', '病理记录。'],
    ['2021-04-06签发且复发的病理记录。', '病理记录。'],
    ['2021-04-06未签发的病理记录。', '病理记录。'],
    ['2021-04-06签发的左侧标本病理记录。', '标本病理记录。']
  ])('日期附近的临床事件、否定、部位、条件和时序不能一并删除：%s', (text, afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', text: afterText, materialUncertainty: '具体日期无法确认。' });
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([
    ['未签发于2021-04-06的病理报告。', '未病理报告。'],
    ['并非2021-04-06签发的病理报告。', '并非病理报告。'],
    ['不是由2021-04-06所签发的病理报告。', '不是由病理报告。'],
    ['若2021-04-06签发的病理报告可用。', '若病理报告可用。'],
    ['如果在2021-04-06签发的病理报告可用。', '如果病理报告可用。'],
    ['若该病理报告于2021-04-06签发的记录可用。', '若该病理报告记录可用。'],
    ['除非签发于2021-04-06的病理报告可用。', '除非病理报告可用。'],
    ['不是2021-04-06的病理报告。', '不是病理报告。'],
    ['当2021-04-06签发的病理报告送达时保留记录。', '当病理报告送达时保留记录。']
  ])('元数据时间修饰语不能通过删除改变否定或条件的对象：%s', (text, afterText) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null, text, materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', text: afterText, materialUncertainty: '具体日期无法确认。' });
    expect(inspect(original, reviewed).preserved).toBe(false);
    // 原来的日期单独撤回不改签发/否定/条件文字，不被这次扩大的角色语法反向拦住。
    reviewed.claims[0]!.text = text.replace('2021-04-06', '');
    expect(inspect(original, reviewed).preserved).toBe(true);
  });

  it.each(['该癌症报告的具体日期未确认。', '该复发报告的日期未知。', '该术后报告的日期未知。',
    '该放疗报告日期未知。', '该病理报告的具体日期未确认，病变已恶化。',
    '该病理报告日期未确认，建议停药。', '该病理报告具体的诊断日期未确认。'])('报告指代不能夹带病名、治疗事件或新医学说明：%s', (materialUncertainty) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2021-04-06签发的病理记录：本条不据此确立癌症或复发，也不包含术后和放疗信息。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain',
      text: '病理记录：本条不据此确立癌症或复发，也不包含术后和放疗信息。', materialUncertainty });
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([
    '手术日期尚未确认，但病变已恶化。', '手术日期未确认，建议停药。',
    '手术日期未确认，病变大小为8 mm。', '手术日期已确认。',
    '放疗日期未确认。', '手术日期未确认；缺少当前症状。'
  ])('时间不确定声明不能夹带新断言、操作、数值或新事件：%s', (materialUncertainty) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024-02-03手术记录病变大小为7 mm。', materialUncertainty: null });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.claims[0]!, { temporalStatus: 'uncertain', materialUncertainty,
      text: '手术记录病变大小为7 mm。' });
    expectRejected(original, reviewed, 'date_scope_or_precision_changed');
  });

  it.each(['month', 'retained_date', 'reassign', 'number', 'comparator', 'unit', 'negation', 'source', 'knowledge',
    'uncertainty_removed', 'temporal_certain', 'medication'] as const)('纯日期撤回不能同时改变其他事实或边界：%s', (change) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024-02-03手术记录病变大小为<7 mm，未见转移；2024-02-08病理记录指标为4.2 mmol/L。',
      materialUncertainty: '缺少当前症状。' });
    const reviewed = structuredClone(original);
    const claim = reviewed.claims[0]!;
    Object.assign(claim, { temporalStatus: 'uncertain', materialUncertainty: '缺少当前症状。手术日期尚未确认。',
      text: '手术记录病变大小为<7 mm，未见转移；病理记录指标为4.2 mmol/L。' });
    if (change === 'month') claim.text = `2024年2月${claim.text}`;
    if (change === 'retained_date') claim.text = `${claim.text}报告日期为2024-02-08。`;
    if (change === 'reassign') claim.text = '病理记录病变大小为<7 mm，未见转移；手术记录指标为4.2 mmol/L。';
    if (change === 'number') claim.text = claim.text.replace('4.2 mmol/L', 'mmol/L');
    if (change === 'comparator') claim.text = claim.text.replace('<7', '>7');
    if (change === 'unit') claim.text = claim.text.replace('7 mm', '7 cm');
    if (change === 'negation') claim.text = claim.text.replace('未见转移', '可见转移');
    if (change === 'source') claim.evidenceIds = ['source:first'];
    if (change === 'knowledge') claim.knowledgeSourceIds = [];
    if (change === 'uncertainty_removed') claim.materialUncertainty = '手术日期尚未确认。';
    if (change === 'temporal_certain') claim.temporalStatus = 'historical';
    if (change === 'medication') claim.text += '请开始服用合成药。';
    expect(inspect(original, reviewed).preserved).toBe(false);
  });

  it.each([
    '2024年2月检查记录指标为4.2 mmol/L；后续病理记录病变大小为7 mm。',
    '2024-02 检查记录指标为4.2 mmol/L；后续病理记录病变大小为7 mm。',
    '2024/02 检查记录指标为4.2 mmol/L；后续病理记录病变大小为7 mm。',
    '2024年检查记录指标为4.2 mmol/L；后续病理记录病变大小为7 mm。',
    '2024年2月8日检查记录指标为4.2 mmol/L；2024年2月3日病理记录病变大小为7 mm。'
  ])('来源事实降低日期精度、删除日期或调换事件日期仍保持拦截：%s', (text) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
      text: '2024年2月3日检查记录指标为4.2 mmol/L；2024年2月8日病理记录病变大小为7 mm。' });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = text;
    const result = inspect(original, reviewed);
    expect(result).toEqual({ preserved: false, reasonCodes: ['date_scope_or_precision_changed'] });
  });

  it('非来源事实添加未获原引用授权的年月也标记日期范围而不是新检验值', () => {
    const original = candidate();
    original.questions[0]!.question = '这次检查是否已有后续资料？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = '2024年2月的这次检查是否已有后续资料？';
    expect(inspect(original, reviewed, 'question:synthetic'))
      .toEqual({ preserved: false, reasonCodes: ['date_scope_or_precision_changed'] });
  });

  it('日期变化同时新增真实数值时仍保留数值拦截，不能被日期分类掩盖', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = '2024年2月原报告记录该次指标为 4.3 mmol/L。';
    const result = inspect(original, reviewed);
    expect(result.preserved).toBe(false);
    expect(result.reasonCodes).toContain('source_fact_numeric_changed');
    expect(result.reasonCodes).toContain('numeric_fact_added');
  });

  it.each(['原报告记录指标为4.2 mmol/L。', '原报告记录指标为7 mmol/L及4.2 mmol/L。'])(
    '来源事实删除、重排真实数值仍使用数值原因：%s', (text) => {
      const original = candidate();
      Object.assign(original.claims[0]!, { kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        text: '原报告记录指标为4.2 mmol/L及7 mmol/L。' });
      const reviewed = structuredClone(original);
      reviewed.claims[0]!.text = text;
      expectRejected(original, reviewed, 'source_fact_numeric_changed');
    });

  it('旧来源、无日期或混合日期不能改 current，撤掉旧支持也无效', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.temporalStatus = 'current';
    reviewed.claims[0]!.evidenceIds = ['source:first'];
    const sources = catalog('2026-10-16');
    sources[1]!.quote = '2024-02-03 的旧资料于2026-10-16整理。';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('temporal_scope_changed');
    for (const date of ['2024-02-03', '']) {
      expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', catalog(date), '2026-10-16').preserved).toBe(false);
    }
  });

  it.each(['new_direction', 'definite_upgrade'] as const)('已有高影响复核不能授权 %s', (change) => {
    const original = candidate();
    Object.assign(original.claims[0]!, { diseaseName: '急性冠脉综合征', diagnosticStatus: 'possible',
      text: '不能排除急性冠脉综合征。' });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.rationale = change === 'new_direction' ? '不能排除肺栓塞。' : '已经确诊急性冠脉综合征。';
    expectRejected(original, reviewed, 'high_consequence_assertion_expanded');
  });

  it.each(['key', 'scope', 'kind', 'timing', 'urgency', 'medication', 'supplement', 'empty'] as const)('日常行动缩小依赖不能同时改变 %s', (change) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    const action = reviewed.actions[0]!;
    action.claimIds = [];
    const codes: Record<typeof change, AssessmentReviewBoundaryReason> = {
      key: 'identity_changed', scope: 'system_scope_changed', kind: 'action_scope_changed', timing: 'action_scope_changed',
      urgency: 'urgency_increased', medication: 'medication_instruction_changed', supplement: 'supplement_dose_introduced', empty: 'support_empty'
    };
    if (change === 'key') action.dedupeKey = 'another-action';
    if (change === 'scope') action.systemIds.push('endocrine_metabolic');
    if (change === 'kind') action.kind = 'treatment_discussion';
    if (change === 'timing') action.timingBasis = 'guideline';
    if (change === 'urgency') action.urgency = 'urgent';
    if (change === 'medication') action.firstStep = '请立即停药。';
    if (change === 'supplement') action.firstStep = '每日补充维生素D 1000 IU。';
    if (change === 'empty') action.evidenceIds = [];
    expectRejected(original, reviewed, codes[change], action.id);
  });

  it('系统状态不能借删除引用从关注改为无异常', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.systems[0]!.status = 'no_signal_in_scope';
    expectRejected(original, reviewed, 'system_status_changed', 'system:digestive');
  });

  it.each(['attention', 'monitor'] as const)('本批重建系统只凭显式能力恢复原%s，默认权限仍拒绝', (status) => {
    const original = candidate();
    Object.assign(original.systems[0]!, { status: 'insufficient', claimIds: ['claim:synthetic'], actionIds: [] });
    const reviewed = structuredClone(original);
    reviewed.systems[0]!.status = status;
    expect(inspect(original, reviewed, 'system:digestive').reasonCodes).toContain('system_status_changed');
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'system:digestive', catalog(), '2026-10-16', [],
      [{ targetId: 'system:digestive', systemId: 'digestive', originalStatus: status }]).preserved).toBe(true);
  });

  it.each(['other_status', 'new_support', 'empty', 'missing_claim', 'other_system', 'unknown_evidence', 'knowledge_only'] as const)(
    '重建恢复权限不能放行%s', (change) => {
      const original = candidate();
      Object.assign(original.systems[0]!, { status: 'insufficient', claimIds: ['claim:synthetic'], actionIds: [] });
      const reviewed = structuredClone(original);
      reviewed.systems[0]!.status = 'attention';
      let sources = catalog();
      if (change === 'other_status') reviewed.systems[0]!.status = 'monitor';
      if (change === 'new_support') reviewed.systems[0]!.claimIds.push('claim:new');
      if (change === 'empty') reviewed.systems[0]!.claimIds = [];
      if (change === 'missing_claim') reviewed.claims = [];
      if (change === 'other_system') reviewed.claims[0]!.systemIds = ['endocrine_metabolic'];
      if (change === 'unknown_evidence') reviewed.claims[0]!.evidenceIds = ['missing-source'];
      if (change === 'knowledge_only') sources = sources.map((source) => ({ ...source, kind: 'knowledge', knowledgeId: 'book' }));
      expect(inspectAssessmentReviewBoundary(original, reviewed, 'system:digestive', sources, '2026-10-16', [],
        [{ targetId: 'system:digestive', systemId: 'digestive', originalStatus: 'attention' }]).preserved).toBe(false);
    });

  it('恢复原关注状态不授权新增日期、数值或疾病断言', () => {
    const original = candidate();
    Object.assign(original.systems[0]!, { status: 'insufficient', claimIds: ['claim:synthetic'], actionIds: [] });
    const reviewed = structuredClone(original);
    Object.assign(reviewed.systems[0]!, { status: 'attention', summary: '2027年1月2日已经确诊恶性肿瘤，结果为93。' });
    const result = inspectAssessmentReviewBoundary(original, reviewed, 'system:digestive', catalog(), '2026-10-16', [],
      [{ targetId: 'system:digestive', systemId: 'digestive', originalStatus: 'attention' }]);
    expect(result.preserved).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['numeric_fact_added', 'high_consequence_assertion_expanded']));
  });

  it('本系统个人锚点允许行动保留跨系统辅助限制，不能只借异系统主张恢复状态', () => {
    const original = candidate();
    Object.assign(original.systems[0]!, { status: 'insufficient', claimIds: ['claim:synthetic'] });
    original.claims.push({ ...original.claims[0]!, id: 'claim:other', systemIds: ['renal_urinary'] });
    const reviewed = structuredClone(original);
    reviewed.systems[0]!.status = 'attention';
    const restore = () => inspectAssessmentReviewBoundary(original, reviewed, 'system:digestive', catalog(), '2026-10-16', [],
      [{ targetId: 'system:digestive', systemId: 'digestive', originalStatus: 'attention' }]);
    expect(restore().preserved).toBe(true);
    original.systems[0]!.claimIds = [];
    reviewed.systems[0]!.claimIds = [];
    original.actions[0]!.claimIds = ['claim:other'];
    reviewed.actions[0]!.claimIds = ['claim:other'];
    original.actions[0]!.evidenceIds = [];
    reviewed.actions[0]!.evidenceIds = [];
    expect(restore().reasonCodes).toContain('system_status_changed');
  });

  it('routine 标签不能掩盖正文升级为立即急诊', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.firstStep = '立即前往急诊就医。';
    expectRejected(original, reviewed, 'urgency_increased', 'action:synthetic');
  });

  it('已有 emergency 范围允许改写同等紧急程度的就医表述', () => {
    const original = candidate();
    original.actions[0]!.urgency = 'emergency';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.firstStep = '立即前往急诊就医。';
    expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(true);
  });

  it('非行动字段也不能新增直接停药指令', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.rationale = '请立即停药。';
    expectRejected(original, reviewed, 'medication_instruction_changed');
  });

  it.each([
    ['如果有不适；不要自行停用合成药。', '如果没有不适；不要自行停用合成药。'],
    ['只有医生已明确同意；可以服用合成药。', '既有资料另有说明；可以服用合成药。'],
    ['除非医生另有安排。不要自行停用合成药。', '原资料日期未知。不要自行停用合成药。'],
    ['复诊前；不要自行停用合成药。', '复诊后；不要自行停用合成药。'],
    ['不要自行停用合成药。', '如果出现不适；不要自行停用合成药。'],
    ['如果有不适，不要自行停用合成药。', '如果没有不适，不要自行停用合成药。'],
    ['旧资料另有说明；不要自行停用合成药，具体安排由接诊医生确认。', '资料日期未知。不要自行停用合成药。'],
    ['旧资料另有说明；不要自行停用合成药。', '资料日期未知。不要自行停用另一合成药。'],
    ['旧资料另有说明；不要自行停用合成药。', '资料日期未知。可以自行停用合成药。'],
    ['旧资料另有说明；不要自行停用合成药。', '资料日期未知。不要自行停用合成药。建议减量。'],
    ['过敏者例外。不要自行停用合成药。', '不要自行停用合成药。'],
    ['备孕阶段不适用这项安排。不要自行停用合成药。', '不要自行停用合成药。'],
    ['医生确认适合后再讨论后续安排。不要自行停用合成药。', '不要自行停用合成药。'],
    ['下句并非可执行安排；可以服用合成药。', '可以服用合成药。']
  ])('按完整语句比较也不能删除或改变条件、对象、否定和附带动作：%s', (before, after) => {
    const original = candidate();
    original.actions[0]!.why = before;
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.why = after;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each(['57.3', '57.3 mmol/L', '<5.7 umol/L', '5.73E+01 mL/min/1.73m2'])(
    '完整禁令和原有独立定性说明不变时，可以抽象单次检验值%s', (value) => {
      const original = candidate();
      original.actions[0]!.why = '对应单次检验指标轻低。';
      original.actions[0]!.caution = `不因单次${value}自行采用限制性饮食或停用既有处方药。`;
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = '不因单次检验指标轻低自行采用限制性饮食或停用既有处方药。';
      reviewed.actions[0]!.knowledgeSourceIds = [];
      reviewed.actions[0]!.evidenceIds = ['source:first'];
      expect(inspect(original, reviewed, 'action:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
      expect(reviewed.actions[0]!.firstStep).toBe(original.actions[0]!.firstStep);
      expect(reviewed.actions[0]!.kind).toBe(original.actions[0]!.kind);
      expect(reviewed.actions[0]!.timing).toBe(original.actions[0]!.timing);
    }
  );

  it.each(['不因单次', '不因为一次', '不应因单次', '不要因为一次'])(
    '允许背景收窄时仍保留完整且原样的否定因果前缀：%s', (lead) => {
      const original = candidate();
      original.actions[0]!.why = `对应${lead.endsWith('一次') ? '一次' : '单次'}检查数值偏低。`;
      original.actions[0]!.caution = `${lead}57.3自行调整剂量或停用合成处方药。`;
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = `${lead}检查数值偏低自行调整剂量或停用合成处方药。`;
      expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(true);
    }
  );

  it.each(['指标偏低', '数值轻高', '结果异常', '检验指标轻低', '检测结果偏高',
    '检查数值轻度偏低', '化验结果波动', '测量数值变化'])(
    '封闭通用背景须重用原独立说明的完整范围和定性：%s', (background) => {
      const original = candidate();
      original.actions[0]!.why = `对应单次${background}。`;
      original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = `不因单次${background}自行停用合成处方药。`;
      expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(true);
    }
  );

  it.each([
    '合成检验（请立即停药）指标偏低', '合成检验（必须减量）指标偏低',
    '合成检验（建议减量）指标偏低', '合成检验（宜停药）指标偏低',
    '合成指标（隔天服）数值偏低', '合成检验（胸痛）指标偏低',
    '头晕检测结果偏低', '宜停药指标偏低', '建议减量数值偏低',
    '隔天服检测结果偏低', '合成指标偏低', '体积指标轻低'
  ])('任意新旧前缀及嵌套命令、症状不能冒充名词性测量背景：%s', (background) => {
    const original = candidate();
    // 即使原说明出现过相同文字，也不能据此认证任意前缀是一个测量名词。
    original.actions[0]!.why = `对应单次${background}。`;
    original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = `不因单次${background}自行停用合成处方药。`;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each([
    '既有资料只记录了原始测量。', '对应单次数值偏高。', '对应单次数值轻低。',
    '对应一次数值偏低。', '如果胸痛，对应单次数值偏低。',
    '如果胸痛；对应单次数值偏低。', '对应单次数值偏低（宜停药）。',
    '对应单次数值偏低；建议减量。', '对应单次数值偏低；另有无关说明。'
  ])('裸数值不能自行推出定性，也不能摘取条件或并列说明作为授权：%s', (why) => {
    const original = candidate();
    original.actions[0]!.why = why;
    original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = '不因单次数值偏低自行停用合成处方药。';
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it('复核新增的说明和其他节点的说明都不能为本节点背景改写自授权', () => {
    const original = candidate();
    original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
    original.claims[0]!.rationale = '对应单次数值偏低。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.why = '对应单次数值偏低。';
    reviewed.actions[0]!.caution = '不因单次数值偏低自行停用合成处方药。';
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each(['title', 'why', 'firstStep', 'timing', 'reviewPlan'] as const)(
    '背景窄例外不授予另一个%s字段新增用药操作的权限', (field) => {
      for (const instruction of ['宜停药。', '建议减量。', '隔天服。', '每日服用合成药。']) {
        const original = candidate();
        original.actions[0]!.why = '对应单次数值偏低。';
        original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
        const reviewed = structuredClone(original);
        reviewed.actions[0]!.caution = '不因单次数值偏低自行停用合成处方药。';
        reviewed.actions[0]![field] = instruction;
        expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
      }
    }
  );

  it.each(['宜停药。', '建议减量。', '隔天服。', '每日服用合成药。'])(
    '完整字段保护不依赖请、必须或建议你的命令前缀：%s', (instruction) => {
      const original = candidate();
      const reviewed = structuredClone(original);
      reviewed.claims[0]!.rationale = instruction;
      expectRejected(original, reviewed, 'medication_instruction_changed');
    }
  );

  it.each(['不要自行服用合成药。', '不要隔天服。', '切勿自行减量。'])(
    '操作识别扩展后仍不能删除原有否定用药提醒：%s', (caution) => {
      const original = candidate();
      original.actions[0]!.caution = caution;
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = null;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
    }
  );

  it.each(['隔天服。', '每日服。', '睡前服。', '每隔两日服。', '每周两次服。',
    '早晚各服。', '餐后服。', '按需服。', '原有说明（隔日服）',
    '隔天服合成药。', '每日服合成片。', '睡前服合成胶囊。', '每周两次服合成甲。'])(
    '明确给药频次或时间结构既保护裸服也保护服后的宾语：%s', (instruction) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = instruction;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each(['firstStep', 'why', 'title'] as const)(
    '合法背景收窄不能掩盖另一个%s字段的服加宾语指令', (field) => {
      const original = candidate();
      original.actions[0]!.why = '对应单次数值偏低。';
      original.actions[0]!.caution = '不因单次57.3自行停用合成药。';
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = '不因单次数值偏低自行停用合成药。';
      reviewed.actions[0]![field] = '隔天服合成药。';
      expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
    }
  );

  it.each(['身体感觉很舒服。', '调整到更舒服的姿势。', '选择合适衣服。', '选择透气的运动服。',
    '每日服装保持透气。', '睡前服饰以舒适为主。'])(
    '普通词中的服不能额外制造用药误拦：%s', (text) => {
      const original = candidate();
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.firstStep = text;
      expect(inspect(original, reviewed, 'action:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
    }
  );

  it.each([
    ['这次检查时是否正在服药、抽血前是否空腹？', '这份报告的采样条件是什么，采样时是否使用药物或空腹？'],
    ['该次检查当时是否服药？', '该次检查当时是否正在用药？'],
    ['抽血当时是否服药？', '抽血当时是否使用药物？'],
    ['这次检查时是否正在服药？', '目前正在服用哪些药物？'],
    ['这次检查时是否正在服药？', '当前有无用药？'],
    ['这次检查时是否正在服药？', '这次检查时是否服用合成药？'],
    ['这次检查时是否正在服药？', '现在正在服药吗？']
  ])('带个人来源的中性既有检查用药状态问题可收窄依赖并改写：%s', (before, after) => {
    const original = candidate();
    original.questions[0]!.question = before;
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = after;
    reviewed.questions[0]!.relatedClaimIds = [];
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each([
    '这次检查时是否需要服药？', '这次检查时是否应该用药？', '下次检查时是否正在服药？',
    '这份报告建议下次检查时是否服药？', '这次检查时是否正在服药、宜停药？',
    '这次检查时是否正在服药、建议减量？', '这次检查时是否正在服药、隔天服合成药？',
    '这次检查时是否正在服药、请开始服用合成药？', '这次检查时是否正在服药、不要自行停药？',
    '这次检查时是否服药减少剂量？', '目前是否可以用药？',
    '目前用药情况如何、是否应该增加药量？'
  ])('问题节点不能把用药决策、未来方案或附带指令当中性状态追问：%s', (question) => {
    const original = candidate();
    original.questions[0]!.question = '这次检查时是否正在服药？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = question;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'question:synthetic');
  });

  it('状态问题与背景说明不按字段锁死，但不能删掉已有否定用药提醒', () => {
    const original = candidate();
    original.questions[0]!.question = '这次检查时是否正在服药？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.whyItMatters = '这次检查时是否正在用药？';
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
    const withReminder = structuredClone(original);
    withReminder.questions[0]!.question = '这次检查时是否正在服药、不要自行停药？';
    expectRejected(withReminder, original, 'medication_instruction_changed', 'question:synthetic');
  });

  it.each([
    '用药情况会影响对检查结果的理解。',
    '服药背景有助于解释既有结果。',
    '用药可能影响检查结果。',
    '正在使用药物与否会影响对既有结果的理解。',
    '请补充用药信息，便于医生结合既有治疗评估。',
    '口服药物可能影响检查结果。',
    '了解检查时的用药和采样背景，有助于解释既有结果。',
    '既有服药与抽血情况有助于理解该次结果。',
    '补充用药及治疗背景，便于理解既有结果。'
  ])('复核可解释既有用药背景而不新增治疗操作：%s', (explanation) => {
    const original = candidate();
    original.questions[0]!.question = '这次检查时是否正在服药？';
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.question = '目前正在服用哪些药物？';
    reviewed.questions[0]!.whyItMatters = explanation;
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it('缺资料谓词作用于完整并列宾语，去掉已证实的方法缺口不冻结仍未知的治疗与用药背景', () => {
    const original = candidate();
    Object.assign(original.claims[0]!, { kind: 'interpretation', diseaseName: null, diagnosticStatus: null,
      text: '既有记录需结合背景理解，但本次未提供治疗经过、检测方法及检测前用药，不能据此推断当前状态。',
      materialUncertainty: '治疗经过、检测方法及检测前用药未提供。' });
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = '既有记录写明 MethodX17，但本次未提供治疗经过及检测前用药，不能据此推断当前状态。';
    reviewed.claims[0]!.materialUncertainty = '本次未提供治疗经过及检测前用药，仍需了解当时背景。';
    const sources = catalog();
    sources[0]!.quote = '检测方法：MethodX17；其他背景未记录。';
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16'))
      .toEqual({ preserved: true, reasonCodes: [] });
    expect(reviewed.claims[0]!.materialUncertainty).toContain('未提供治疗经过及检测前用药');
    // 方法数字必须仍是已引用来源中的完整标识，不凭不同表述或相同数值猜同义。
    reviewed.claims[0]!.text = reviewed.claims[0]!.text.replace('MethodX17', '合成-17方法');
    expect(inspectAssessmentReviewBoundary(original, reviewed, 'claim:synthetic', sources, '2026-10-16').reasonCodes)
      .toContain('numeric_fact_added');
  });

  it.each([
    '本次未提供治疗经过及检测前用药，建议立即用药。',
    '本次未提供治疗经过及检测前用药；不要自行停药。',
    '本次未提供治疗经过及检测前用药，但请每天口服合成药。',
    '本次未提供治疗经过及立即用药。',
    '本次未提供治疗经过及下次检测前用药。',
    '本次未提供治疗经过及用药治疗不适。',
    '本次未提供治疗经过及用药2片。',
    '本次未提供治疗经过及停药安排。',
    '本次未提供治疗经过及检测前用药，因此请改用合成药。'
  ])('缺资料前缀不能吞掉独立操作、否定提醒、未来方案或剂量：%s', (text) => {
    const original = candidate();
    original.claims[0]!.text = '本次未提供治疗经过、方法及检测前用药。';
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.text = text;
    expectRejected(original, reviewed, 'medication_instruction_changed');
  });

  it('状态追问保留依赖时，说明可在既有治疗与采样背景内收窄措辞', () => {
    const original = candidate();
    Object.assign(original.questions[0]!, { question: '这次检查时是否正在服药？',
      whyItMatters: '了解检查时的用药和采样背景，有助于解释既有结果。' });
    const reviewed = structuredClone(original);
    reviewed.questions[0]!.whyItMatters = '既有服药及抽血情况有助于理解该次结果。';
    expect(reviewed.questions[0]!.evidenceIds).toEqual(original.questions[0]!.evidenceIds);
    expect(reviewed.questions[0]!.relatedClaimIds).toEqual(original.questions[0]!.relatedClaimIds);
    expect(inspect(original, reviewed, 'question:synthetic')).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['whyItMatters', 'question'] as const)('不能借中性 %s 放行并列或嵌套的治疗操作', (field) => {
    for (const instruction of ['用药情况会影响结果，请停药。', '目前正在服药吗？建议减量。',
      '服药背景有助理解结果（请每日口服合成药）。', '用药信息尚缺；剂量需要增加。',
      '现在有无用药、隔天服合成药即可？', '这次检查时是否正在服药，并改用合成药？']) {
      const original = candidate();
      const reviewed = structuredClone(original);
      reviewed.questions[0]![field] = instruction;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'question:synthetic');
    }
  });

  it.each(['claim', 'action', 'overview', 'system'] as const)('中性背景说明在 %s 节点也不是治疗操作', (type) => {
    const original = candidate();
    const reviewed = structuredClone(original);
    const explanation = '用药情况会影响对既有结果的理解。';
    if (type === 'claim') reviewed.claims[0]!.rationale = explanation;
    if (type === 'action') reviewed.actions[0]!.why = explanation;
    if (type === 'overview') reviewed.overview.summary = explanation;
    if (type === 'system') reviewed.systems[0]!.summary = explanation;
    const id = type === 'claim' ? 'claim:synthetic' : type === 'action' ? 'action:synthetic'
      : type === 'overview' ? 'overview' : 'system:digestive';
    expect(inspect(original, reviewed, id)).toEqual({ preserved: true, reasonCodes: [] });
  });

  it.each(['用药信息：每日2次。', '正在服用哪些药物，服药情况为每次2片。', '用药背景为合成药5mg。'])(
    '名词性背景不能授权新增给药剂量：%s', (instruction) => {
      const original = candidate();
      const reviewed = structuredClone(original);
      reviewed.questions[0]!.whyItMatters = instruction;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'question:synthetic');
    });

  it.each(['用药背景有助理解结果，不要自行停药。', '请提供服药信息，切勿自行调整药量。'])(
    '解释字段中的否定治疗提醒仍须完整保留：%s', (reminder) => {
      const original = candidate();
      original.questions[0]!.whyItMatters = reminder;
      const reviewed = structuredClone(original);
      reviewed.questions[0]!.whyItMatters = '既有治疗信息有助于理解结果。';
      expectRejected(original, reviewed, 'medication_instruction_changed', 'question:synthetic');
    });

  it.each([
    ['删除否定', '因单次检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['替换否定', '无需因单次检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['删除单次范围', '不因检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['替换单次范围', '不因一次检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['改成症状', '不因单次头晕自行采用限制性饮食或停用既有处方药。'],
    ['加入症状条件', '不因单次有头晕时的检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['加入时间条件', '不因单次睡前的检验指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['加入药物背景', '不因单次合成处方药指标轻低自行采用限制性饮食或停用既有处方药。'],
    ['替换药名', '不因单次检验指标轻低自行采用限制性饮食或停用另一合成药。'],
    ['新增剂量', '不因单次检验指标轻低自行采用限制性饮食或停用既有处方药5mg。'],
    ['替换开始停止动作', '不因单次检验指标轻低自行采用限制性饮食或开始服用既有处方药。'],
    ['删除停止动作', '不因单次检验指标轻低自行采用限制性饮食。'],
    ['新增独立用药动作', '不因单次检验指标轻低自行采用限制性饮食或停用既有处方药；请立即换药。'],
    ['删除整个禁令', null]
  ])('背景改写不能顺带%s', (_label, caution) => {
    const original = candidate();
    original.actions[0]!.why = '对应单次检验指标轻低。';
    original.actions[0]!.caution = '不因单次57.3自行采用限制性饮食或停用既有处方药。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = caution;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each([
    ['如果头晕，不要自行停用合成处方药。', '如果胸痛，不要自行停用合成处方药。'],
    ['没有头晕时不要自行停用合成处方药。', '出现头晕时不要自行停用合成处方药。'],
    ['复诊前不要自行停用合成处方药。', '复诊后不要自行停用合成处方药。'],
    ['睡前不要自行停用合成处方药。', '餐后不要自行停用合成处方药。'],
    ['除非医生已另作安排，不要自行停用合成处方药。', '除非出现不适，不要自行停用合成处方药。'],
    ['若合成检查异常，不因单次57.3自行停用合成处方药。', '若出现不适，不因单次合成指标轻低自行停用合成处方药。'],
    ['不因单次头晕自行停用合成处方药。', '不因单次胸痛自行停用合成处方药。'],
    ['不因单次合成指标偏低自行停用合成处方药。', '不因单次另一指标偏低自行停用合成处方药。']
  ])('最短否定用药子句相同也不能改症状、时间或适用条件：%s', (before, after) => {
    const original = candidate();
    original.actions[0]!.caution = before;
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.caution = after;
    expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
  });

  it.each(['5mg', '2周', '头晕', '睡前57.3', '若异常57.3'])(
    '药物剂量、疗程、症状或带条件背景不能冒充可抽象的单次数值：%s', (value) => {
      const original = candidate();
      original.actions[0]!.caution = `不因单次${value}自行停用合成处方药。`;
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.caution = '不因单次合成指标轻低自行停用合成处方药。';
      expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
    }
  );

  it('否定用药提醒不能移到另一个展示字段，或删除否定后保留同一个药物动作', () => {
    const original = candidate();
    original.actions[0]!.caution = '不因单次57.3自行停用合成处方药。';
    const moved = structuredClone(original);
    moved.actions[0]!.caution = null;
    moved.actions[0]!.why = '不因单次合成指标轻低自行停用合成处方药。';
    expectRejected(original, moved, 'medication_instruction_changed', 'action:synthetic');
    const removedNegation = structuredClone(original);
    removedNegation.actions[0]!.caution = '请自行停用合成处方药。';
    expectRejected(original, removedNegation, 'medication_instruction_changed', 'action:synthetic');
  });

  it('同类非行动展示字段不能用自身改写内容为背景变化授权', () => {
    const original = candidate();
    original.claims[0]!.rationale = '不因单次57.3自行停用合成处方药。';
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.rationale = '不因单次合成指标轻低自行停用合成处方药。';
    expectRejected(original, reviewed, 'medication_instruction_changed');
    reviewed.claims[0]!.rationale = '如果头晕，不因单次合成指标轻低自行停用合成处方药。';
    expectRejected(original, reviewed, 'medication_instruction_changed');
  });

  it('不涉及单次数值背景的用药动作、药名和剂量仍按完整字段拒绝变化', () => {
    const original = candidate();
    original.actions[0]!.caution = '不要自行停用合成甲药5mg。';
    const reviewed = structuredClone(original);
    for (const text of ['不要自行停用合成乙药5mg。', '不要自行停用合成甲药10mg。',
      '不要自行开始服用合成甲药5mg。', '自行停用合成甲药5mg。']) {
      reviewed.actions[0]!.caution = text;
      expectRejected(original, reviewed, 'medication_instruction_changed', 'action:synthetic');
    }
  });

  it.each(['id', 'remove_id', 'first_step'] as const)('已绑定原始医嘱不能改 %s', (change) => {
    const original = candidate();
    original.actions[0]!.sourceInstructionObservationId = 'observation:synthetic';
    const reviewed = structuredClone(original);
    if (change === 'id') reviewed.actions[0]!.sourceInstructionObservationId = 'observation:another';
    if (change === 'remove_id') delete reviewed.actions[0]!.sourceInstructionObservationId;
    if (change === 'first_step') reviewed.actions[0]!.firstStep += ' 请遵循原安排。';
    expectRejected(original, reviewed, 'source_instruction_changed', 'action:synthetic');
  });

  it('P04 不能给原本未绑定的行动新增医嘱绑定；保留绑定时可改其他说明', () => {
    const original = candidate();
    original.actions[0]!.firstStep = '请立即停药。';
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.sourceInstructionObservationId = 'observation:synthetic';
    expectRejected(original, reviewed, 'source_instruction_changed', 'action:synthetic');
    original.actions[0]!.sourceInstructionObservationId = 'observation:synthetic';
    reviewed.actions[0]!.why = '请结合既有来源向医生确认。';
    expect(inspect(original, reviewed, 'action:synthetic').preserved).toBe(true);
  });

  it('拒绝原因去重且不携带正文或个人标识', () => {
    const original = candidate();
    const reviewed = structuredClone(original);
    reviewed.claims[0]!.evidenceIds = ['source:new', 'source:new'];
    const result = inspect(original, reviewed);
    expect(result.reasonCodes.filter((code) => code === 'support_expanded')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-person|source:new|胃炎|4\.2/);
  });
});
